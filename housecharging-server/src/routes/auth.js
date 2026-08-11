import { Router } from 'express';
import { query } from '../db.js';
import { signToken, hashPassword, verifyPassword, passwordTooShort, MIN_PASSWORD_LENGTH } from '../auth.js';
import { lockoutRemaining, registerFailure, clearAttempts } from '../loginGuard.js';

const router = Router();

// Read the admin-configurable brute-force settings (threshold + lockout window).
async function loginConfig() {
  const { rows } = await query('SELECT max_login_attempts, login_lockout_minutes FROM settings WHERE id=1');
  const s = rows[0] || {};
  return {
    maxAttempts: Number(s.max_login_attempts) || 0, // 0 = lockout disabled
    lockoutMs: (Number(s.login_lockout_minutes) || 15) * 60 * 1000,
  };
}

// 429 with a human-readable wait time and a Retry-After header.
function lockedResponse(res, secs) {
  res.set('Retry-After', String(secs));
  const mins = Math.ceil(secs / 60);
  return res.status(429).json({
    error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
    retryAfter: secs,
  });
}

// Admin login
router.post('/admin/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    // Read the credentials first: the username is part of the lockout key now.
    const locked = await lockoutRemaining('admin', username, req);
    if (locked) return lockedResponse(res, locked);
    const { rows } = await query('SELECT * FROM admins WHERE username=$1', [username]);
    const admin = rows[0];
    if (!admin || !(await verifyPassword(password, admin.password_hash))) {
      const { maxAttempts, lockoutMs } = await loginConfig();
      const { lockedFor } = await registerFailure('admin', username, req, maxAttempts, lockoutMs);
      if (lockedFor) return lockedResponse(res, lockedFor);
      return res.status(401).json({ error: 'Incorrect username or password' });
    }
    await clearAttempts('admin', username, req);
    const token = signToken({ role: 'admin', id: admin.id, username: admin.username });
    res.json({ token, role: 'admin', username: admin.username });
  } catch (e) { next(e); }
});

// Owner login (only approved owners may sign in)
router.post('/owner/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    // Read the credentials first: the username is part of the lockout key now.
    const locked = await lockoutRemaining('owner', username, req);
    if (locked) return lockedResponse(res, locked);
    const { rows } = await query('SELECT * FROM owners WHERE lower(username)=lower($1)', [username]);
    const owner = rows[0];
    if (!owner || !(await verifyPassword(password, owner.password_hash))) {
      const { maxAttempts, lockoutMs } = await loginConfig();
      const { lockedFor } = await registerFailure('owner', username, req, maxAttempts, lockoutMs);
      if (lockedFor) return lockedResponse(res, lockedFor);
      return res.status(401).json({ error: 'Incorrect username or password' });
    }
    // Correct credentials — clear the counter before the approval-state checks
    // (a pending/rejected account is not a failed login).
    await clearAttempts('owner', username, req);
    if (owner.status === 'pending') return res.status(403).json({ error: 'pending' });
    if (owner.status === 'rejected') return res.status(403).json({ error: 'rejected' });
    const token = signToken({ role: 'owner', id: owner.id, username: owner.username, houseNumber: owner.house_number });
    res.json({ token, role: 'owner', username: owner.username, houseNumber: owner.house_number });
  } catch (e) { next(e); }
});

// Owner self-registration (pending until an admin approves)
router.post('/owner/register', async (req, res, next) => {
  try {
    const { username, password, houseNumber } = req.body || {};
    if (!username || !password || !houseNumber)
      return res.status(400).json({ error: 'All fields are required' });
    if (passwordTooShort(password))
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    // Hash regardless of whether the username is taken so the response time doesn't
    // reveal which path was taken (timing-based enumeration), then only insert if free.
    const hash = await hashPassword(password);
    const exists = await query('SELECT 1 FROM owners WHERE lower(username)=lower($1)', [username]);
    if (!exists.rows.length) {
      await query(
        `INSERT INTO owners (username, password_hash, house_number, status)
         VALUES ($1,$2,$3,'pending')`,
        [username, hash, houseNumber]);
    }
    // Always the same generic reply: a taken username can't be probed via register (L-2).
    // A genuine clash surfaces harmlessly when the resident tries to log in, and the
    // admin Approvals tab is the real ownership control.
    res.status(201).json({ status: 'pending' });
  } catch (e) { next(e); }
});

export default router;
