// In-memory brute-force guard for the login endpoints.
//
// The app runs as a single container (one process) so a Map is sufficient and
// avoids a DB write on every login attempt. Keyed by "<scope>:<client-ip>" so
// admin and owner logins are tracked separately. After `maxAttempts` consecutive
// failures from a key it is locked for `lockoutMs`; the threshold is
// admin-configurable (settings.max_login_attempts, default 5).

const attempts = new Map(); // key -> { fails, lockedUntil }

// Trust the first hop of X-Forwarded-For (nginx sets it); fall back to the socket.
export function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.ip || req.socket?.remoteAddress || 'unknown';
}

const keyFor = (scope, req) => `${scope}:${clientIp(req)}`;

// Seconds remaining on an active lockout for this client, or 0 if not locked.
export function lockoutRemaining(scope, req) {
  const key = keyFor(scope, req);
  const rec = attempts.get(key);
  if (!rec || !rec.lockedUntil) return 0;
  const ms = rec.lockedUntil - Date.now();
  if (ms <= 0) { attempts.delete(key); return 0; }
  return Math.ceil(ms / 1000);
}

// Record one failed attempt. Returns { remaining, lockedFor }: `remaining` is how
// many tries are left before lockout, `lockedFor` is the lockout length in seconds
// (0 until the threshold is hit). maxAttempts <= 0 disables the lockout entirely.
export function registerFailure(scope, req, maxAttempts, lockoutMs) {
  if (!maxAttempts || maxAttempts <= 0) return { remaining: Infinity, lockedFor: 0 };
  const key = keyFor(scope, req);
  const rec = attempts.get(key) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= maxAttempts) {
    rec.lockedUntil = Date.now() + lockoutMs;
    rec.fails = 0; // the lockout itself is the penalty; start fresh after it expires
    attempts.set(key, rec);
    return { remaining: 0, lockedFor: Math.ceil(lockoutMs / 1000) };
  }
  attempts.set(key, rec);
  return { remaining: maxAttempts - rec.fails, lockedFor: 0 };
}

// Clear a client's record after a successful login.
export function clearAttempts(scope, req) {
  attempts.delete(keyFor(scope, req));
}

// Test-only: wipe all tracked state.
export function _reset() { attempts.clear(); }
