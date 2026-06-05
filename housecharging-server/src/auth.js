import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

// Fail closed (VAPT L-7): refuse to start without a real JWT_SECRET rather than
// silently signing tokens with a guessable dev default.
const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Refusing to start with an insecure default.');
  process.exit(1);
}
const EXPIRES = '12h';

// Minimum password length enforced when accounts are created or reset (VAPT L-1).
export const MIN_PASSWORD_LENGTH = 8;
export const passwordTooShort = (pw) =>
  typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH;

export const hashPassword = (plain) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

export function signToken(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES });
}

function readToken(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export function authOptional(req, _res, next) {
  const token = readToken(req);
  if (token) {
    try { req.user = jwt.verify(token, SECRET); } catch { /* ignore */ }
  }
  next();
}

export function requireAdmin(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const u = jwt.verify(token, SECRET);
    if (u.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    req.user = u;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

export function requireOwner(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const u = jwt.verify(token, SECRET);
    if (u.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    req.user = u;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}
