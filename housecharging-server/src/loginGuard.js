// Brute-force guard for the login endpoints, backed by the `login_attempts`
// table so lockouts survive a process restart/redeploy.
//
// Tracked per "<scope>:<ip>" (admin and owner logins counted separately). After
// `maxAttempts` consecutive failures from a key it is locked until `locked_until`;
// the threshold is admin-configurable (settings.max_login_attempts, default 5).
// All functions are async (they hit the DB).

import { query } from './db.js';

// Trust the first hop of X-Forwarded-For (nginx sets it); fall back to the socket.
export function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || req.socket?.remoteAddress || 'unknown';
}

const keyFor = (scope, req) => `${scope}:${clientIp(req)}`;

// Seconds remaining on an active lockout for this client, or 0 if not locked.
// Sweeps the record once the lockout has expired.
export async function lockoutRemaining(scope, req) {
  const key = keyFor(scope, req);
  const { rows } = await query('SELECT locked_until FROM login_attempts WHERE id=$1', [key]);
  const lu = rows[0]?.locked_until;
  if (!lu) return 0;
  const ms = new Date(lu).getTime() - Date.now();
  if (ms <= 0) { await query('DELETE FROM login_attempts WHERE id=$1', [key]); return 0; }
  return Math.ceil(ms / 1000);
}

// Record one failed attempt. Returns { remaining, lockedFor }: `remaining` is how
// many tries are left before lockout, `lockedFor` is the lockout length in seconds
// (0 until the threshold is hit). maxAttempts <= 0 disables the lockout entirely.
export async function registerFailure(scope, req, maxAttempts, lockoutMs) {
  if (!maxAttempts || maxAttempts <= 0) return { remaining: Infinity, lockedFor: 0 };
  const key = keyFor(scope, req);
  const { rows } = await query('SELECT fails FROM login_attempts WHERE id=$1', [key]);
  const fails = (rows[0]?.fails || 0) + 1;
  if (fails >= maxAttempts) {
    // Lock out and reset the counter; the lockout itself is the penalty.
    const until = new Date(Date.now() + lockoutMs);
    await query(
      `INSERT INTO login_attempts (id, fails, locked_until, updated_at) VALUES ($1, 0, $2, now())
       ON CONFLICT (id) DO UPDATE SET fails=0, locked_until=$2, updated_at=now()`,
      [key, until]);
    return { remaining: 0, lockedFor: Math.ceil(lockoutMs / 1000) };
  }
  await query(
    `INSERT INTO login_attempts (id, fails, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET fails=$2, updated_at=now()`,
    [key, fails]);
  return { remaining: maxAttempts - fails, lockedFor: 0 };
}

// Clear a client's record after a successful login.
export async function clearAttempts(scope, req) {
  await query('DELETE FROM login_attempts WHERE id=$1', [keyFor(scope, req)]);
}

// Currently locked-out clients, for the admin to review/release. Each entry is
// { key, scope, ip, retryAfter } where retryAfter is seconds left on the lock.
// Expired locks are swept out as a side effect.
export async function listLocked() {
  const now = new Date();
  await query('DELETE FROM login_attempts WHERE locked_until IS NOT NULL AND locked_until <= $1', [now]);
  const { rows } = await query(
    'SELECT id, locked_until FROM login_attempts WHERE locked_until IS NOT NULL AND locked_until > $1 ORDER BY locked_until',
    [now]);
  return rows.map((r) => {
    const sep = r.id.indexOf(':');
    return {
      key: r.id,
      scope: r.id.slice(0, sep),
      ip: r.id.slice(sep + 1),
      retryAfter: Math.ceil((new Date(r.locked_until).getTime() - Date.now()) / 1000),
    };
  });
}

// Admin: release one locked client by key. Returns true if a record was removed.
export async function unlock(key) {
  const { rowCount } = await query('DELETE FROM login_attempts WHERE id=$1', [key]);
  return rowCount > 0;
}

// Admin: release every locked/tracked client. Returns the number cleared.
export async function unlockAll() {
  const { rowCount } = await query('DELETE FROM login_attempts');
  return rowCount;
}

// Test-only: wipe all tracked state.
export async function _reset() { await query('DELETE FROM login_attempts'); }
