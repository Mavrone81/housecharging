// Brute-force guard for the login endpoints, backed by the `login_attempts`
// table so lockouts survive a process restart/redeploy.
//
// Tracked per "<scope>:<username>|<ip>" (admin and owner logins counted
// separately). After `maxAttempts` consecutive failures for a key it is locked
// until `locked_until`; the threshold is admin-configurable
// (settings.max_login_attempts, default 5). All functions are async (they hit
// the DB).
//
// The key includes the USERNAME as well as the address. Per-IP alone misses
// credential stuffing that rotates addresses while walking a list of accounts,
// and it means five wrong guesses lock out every other user behind the same
// office connection. Per-username alone would let anyone deny service to a known
// account. The pair confines a lockout to one attacker and one username.

import { query } from './db.js';

// Peers permitted to speak for the client's address. Defaults to the private
// ranges, which covers the Docker bridge gateway nginx forwards from. Loopback
// is deliberately NOT trusted: in this deployment nothing legitimate reaches the
// app from loopback, and trusting it would let a local process forge addresses.
const TRUSTED_PROXY_CIDRS = String(
  process.env.TRUSTED_PROXY_CIDRS || '10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
).split(',').map((c) => c.trim()).filter(Boolean);

// Strip the IPv4-mapped IPv6 prefix so "::ffff:172.24.0.1" compares as IPv4.
function normalizeIp(ip) {
  const s = String(ip || '').trim();
  return s.startsWith('::ffff:') ? s.slice(7) : s;
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function inCidr(ip, cidr) {
  const [net, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const a = ipv4ToInt(ip); const b = ipv4ToInt(net);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
}

function isTrustedProxy(ip) {
  return TRUSTED_PROXY_CIDRS.some((c) => inCidr(ip, c));
}

// The client's address.
//
// Forwarding headers are believed ONLY when the request actually arrived from a
// trusted proxy. This is the whole point: nginx builds X-Forwarded-For with
// $proxy_add_x_forwarded_for, which APPENDS the real peer to whatever the client
// already sent, so the FIRST entry is attacker-supplied. Reading it -- which this
// function used to do -- let anyone defeat the lockout entirely by sending a
// different fake address on every request. Verified against production before
// this change: eight failed admin logins with a forged header never tripped the
// lock, while eight without it locked on the fifth.
//
// When the peer is trusted we take X-Real-IP (nginx sets it with
// proxy_set_header, which REPLACES any client value), falling back to the LAST
// X-Forwarded-For entry, which is the one the trusted proxy appended. When the
// peer is not trusted, the headers are ignored and the socket address is used.
export function clientIp(req) {
  const peer = normalizeIp(req.socket?.remoteAddress || req.ip || '');
  if (!isTrustedProxy(peer)) return peer || 'unknown';

  const realIp = normalizeIp(req.headers['x-real-ip']);
  if (realIp) return realIp;

  const parts = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((v) => v.trim()).filter(Boolean);
  if (parts.length) return normalizeIp(parts[parts.length - 1]);

  return peer || 'unknown';
}

// '|' separates username from address in the key, so it cannot appear inside the
// username or the key would be ambiguous to parse back out for the admin list.
const normUser = (u) => String(u ?? '').trim().toLowerCase().replace(/\|/g, '_').slice(0, 128);

const keyFor = (scope, username, req) => `${scope}:${normUser(username)}|${clientIp(req)}`;

// Seconds remaining on an active lockout for this client, or 0 if not locked.
// Sweeps the record once the lockout has expired.
export async function lockoutRemaining(scope, username, req) {
  const key = keyFor(scope, username, req);
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
export async function registerFailure(scope, username, req, maxAttempts, lockoutMs) {
  if (!maxAttempts || maxAttempts <= 0) return { remaining: Infinity, lockedFor: 0 };
  const key = keyFor(scope, username, req);
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
export async function clearAttempts(scope, username, req) {
  await query('DELETE FROM login_attempts WHERE id=$1', [keyFor(scope, username, req)]);
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
    // Key is "<scope>:<username>|<ip>". Rows written before the username was part
    // of the key have no '|' and are reported with an empty username.
    const sep = r.id.indexOf(':');
    const scope = r.id.slice(0, sep);
    const rest = r.id.slice(sep + 1);
    const bar = rest.lastIndexOf('|');
    return {
      key: r.id,
      scope,
      user: bar === -1 ? '' : rest.slice(0, bar),
      ip: bar === -1 ? rest : rest.slice(bar + 1),
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
