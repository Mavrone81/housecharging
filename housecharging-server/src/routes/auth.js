import { Router } from 'express';
import { query } from '../db.js';
import { signToken, hashPassword, verifyPassword } from '../auth.js';

const router = Router();

// Admin login
router.post('/admin/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    const { rows } = await query('SELECT * FROM admins WHERE username=$1', [username]);
    const admin = rows[0];
    if (!admin || !(await verifyPassword(password, admin.password_hash)))
      return res.status(401).json({ error: 'Incorrect username or password' });
    const token = signToken({ role: 'admin', id: admin.id, username: admin.username });
    res.json({ token, role: 'admin', username: admin.username });
  } catch (e) { next(e); }
});

// Owner login (only approved owners may sign in)
router.post('/owner/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });
    const { rows } = await query('SELECT * FROM owners WHERE lower(username)=lower($1)', [username]);
    const owner = rows[0];
    if (!owner || !(await verifyPassword(password, owner.password_hash)))
      return res.status(401).json({ error: 'Incorrect username or password' });
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
    const exists = await query('SELECT 1 FROM owners WHERE lower(username)=lower($1)', [username]);
    if (exists.rows.length) return res.status(409).json({ error: 'Username already taken' });
    const hash = await hashPassword(password);
    await query(
      `INSERT INTO owners (username, password_hash, house_number, status)
       VALUES ($1,$2,$3,'pending')`,
      [username, hash, houseNumber]);
    res.status(201).json({ status: 'pending' });
  } catch (e) { next(e); }
});

export default router;
