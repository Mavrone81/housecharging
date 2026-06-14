import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import ownerRoutes from './routes/owner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Content-Security-Policy for the bundled client. 'unsafe-inline' is required
// because the single-file client uses inline <script>/<style> and inline event
// handlers; data: covers the uploaded logo / PromptPay QR / proof images; the
// Google Fonts origins serve the web fonts.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self'",
].join('; ');

// Security response headers (VAPT M-1). HSTS only takes effect over HTTPS, which
// is how clients reach the app (nginx terminates TLS and proxies these through).
function securityHeaders(_req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('Content-Security-Policy', CSP);
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by'); // hide the framework banner (VAPT L-3)
  app.use(securityHeaders);
  app.use(express.json({ limit: '12mb' })); // logo + PromptPay QR data URLs can be large

  const origins = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (origins.length) app.use(cors({ origin: origins }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', publicRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/owner', ownerRoutes);

  // Serve the bundled web client.
  const pub = path.join(__dirname, '..', 'public');
  app.use(express.static(pub));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(pub, 'index.html'));
  });

  // JSON error handler. Surface specific messages for client errors (4xx), but
  // return a generic message for 5xx so internal details don't leak (VAPT L-6).
  app.use((err, _req, res, _next) => {
    console.error(err);
    const status = err.status || 500;
    const message = status >= 500 ? 'Server error' : (err.message || 'Request error');
    res.status(status).json({ error: message });
  });
  return app;
}
