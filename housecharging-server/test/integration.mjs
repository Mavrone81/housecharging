// End-to-end integration test of the real Express routes against an in-memory Postgres.
// Run: node test/integration.mjs  (or `npm test`; pg-mem is a devDependency).
//
// Defaults are set before the app modules load. They use ||= so an externally
// provided DATABASE_URL/JWT_SECRET still wins, and the src modules are imported
// dynamically AFTER these assignments — a plain static import would be hoisted
// above them (ESM evaluates imports first) and trip db.js / auth.js fail-closed
// guards before the env is in place.
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-secret';

import fs from 'node:fs';
import { newDb } from 'pg-mem';
const { setPool } = await import('../src/db.js');
const { hashPassword } = await import('../src/auth.js');
const { _reset: resetGuard } = await import('../src/loginGuard.js');

// Build an in-memory Postgres and a pg-compatible pool, then inject it.
const mem = newDb();
const adapter = mem.adapters.createPg();
const pool = new adapter.Pool();
setPool(pool);

// Apply schema + seed an admin (mirrors migrate.js).
mem.public.none(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
await pool.query('INSERT INTO admins (username, password_hash) VALUES ($1,$2)',
  ['admin', await hashPassword('admin123')]);

const { createApp } = await import('../src/app.js');
const app = createApp();
const server = app.listen(0);
const base = `http://localhost:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok  ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const J = async (path, { method = 'GET', token, body } = {}) => {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

try {
  // 0. security headers (M-1) present + framework banner hidden (L-3)
  {
    const res = await fetch(base + '/api/health');
    const h = res.headers;
    ok(h.get('content-security-policy')?.includes("default-src 'self'"), 'CSP header set');
    ok(h.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
    ok(h.get('x-frame-options') === 'DENY', 'X-Frame-Options: DENY');
    ok((h.get('strict-transport-security') || '').includes('max-age='), 'HSTS header set');
    ok(h.get('referrer-policy') === 'no-referrer', 'Referrer-Policy set');
    ok(!h.get('x-powered-by'), 'X-Powered-By hidden');
  }

  // 1. admin login
  let r = await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  ok(r.status === 200 && r.data.token, 'admin login returns token');
  const adminToken = r.data.token;

  r = await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'wrong' } });
  ok(r.status === 401, 'wrong admin password rejected');

  // 2. admin saves whole state (settings + house + reading)
  r = await J('/api/admin/state', { method: 'PUT', token: adminToken, body: {
    settings: { communityName: 'Charoensap', address: 'Moo 7', currency: 'THB',
      waterRate: 18, waterFixed: 30, gasRate: 25, gasFixed: 20,
      formulaWater: '(curr - prev) * rate + fixed', formulaGas: '(curr - prev) * rate + fixed' },
    houses: [{ cluster: 'Zone A', houseNumber: 'A-101', ownerName: 'Somchai' }],
    readings: [{ houseNumber: 'A-101', period: '2026-04', waterPrev: 135, waterCurr: 152, gasPrev: 48, gasCurr: 55 }],
  }});
  ok(r.status === 200 && r.data.houses.length === 1, 'state saved: 1 house');
  const reading = r.data.readings[0];
  ok(Number(reading.waterCharge) === 336 && Number(reading.gasCharge) === 195 && Number(reading.total) === 531,
    'server computed charges 336/195/531');
  ok(reading.waterNo != null && reading.gasNo != null && reading.waterNo !== reading.gasNo,
    'running invoice numbers assigned & distinct');

  // 3. malicious formula is rejected server-side (falls back to default, still computes)
  r = await J('/api/admin/state', { method: 'PUT', token: adminToken, body: {
    settings: { communityName: 'Charoensap', address: 'Moo 7', currency: 'THB',
      waterRate: 18, waterFixed: 30, gasRate: 25, gasFixed: 20,
      formulaWater: 'process.exit(1)', formulaGas: '(curr - prev) * rate' },
    houses: [{ cluster: 'Zone A', houseNumber: 'A-101', ownerName: 'Somchai' }],
    readings: [{ houseNumber: 'A-101', period: '2026-04', waterPrev: 135, waterCurr: 152, gasPrev: 48, gasCurr: 55 }],
  }});
  ok(r.status === 200, 'malicious formula did not crash server');
  const s2 = (await J('/api/admin/bootstrap', { token: adminToken })).data.settings;
  ok(s2.formula_water === '(curr - prev) * rate + fixed', 'bad formula replaced with default');

  // 4. state sync must NOT be callable without admin token
  r = await J('/api/admin/state', { method: 'PUT', body: { settings: {}, houses: [], readings: [] } });
  ok(r.status === 401, 'unauthenticated state sync blocked');

  // 4a. R1: renaming/renumbering a house preserves its reading history.
  {
    const boot = (await J('/api/admin/bootstrap', { token: adminToken })).data;
    const house = boot.houses.find(h => h.house_number === 'A-101');
    ok(!!house && boot.readings.length === 1, 'R1 setup: A-101 has a reading');
    const settings = { communityName: 'Charoensap', address: 'Moo 7', currency: 'THB',
      waterRate: 18, waterFixed: 30, gasRate: 25, gasFixed: 20,
      formulaWater: '(curr - prev) * rate + fixed', formulaGas: '(curr - prev) * rate' };
    // Save the SAME house by its stable id but with a new house_number, and reference
    // the reading by the new number (as the client would after a rename).
    r = await J('/api/admin/state', { method: 'PUT', token: adminToken, body: {
      baseVersion: boot.settings.state_version,
      settings,
      houses: [{ id: house.id, cluster: 'Zone A', houseNumber: 'A-999', ownerName: 'Somchai' }],
      readings: [{ houseNumber: 'A-999', period: '2026-04', waterPrev: 135, waterCurr: 152, gasPrev: 48, gasCurr: 55 }],
    }});
    ok(r.status === 200 && r.data.houses.length === 1 && r.data.houses[0].house_number === 'A-999',
      'R1: house renamed A-101 -> A-999 (no duplicate house)');
    ok(r.data.houses[0].id === house.id, 'R1: rename kept the same house id (in-place update)');
    ok(r.data.readings.length === 1 && Number(r.data.readings[0].water_curr) === 152,
      'R1: the reading survived the rename');
    // Rename back so later steps still find A-101.
    const ver = r.data.settings.state_version;
    r = await J('/api/admin/state', { method: 'PUT', token: adminToken, body: {
      baseVersion: ver, settings,
      houses: [{ id: house.id, cluster: 'Zone A', houseNumber: 'A-101', ownerName: 'Somchai' }],
      readings: [{ houseNumber: 'A-101', period: '2026-04', waterPrev: 135, waterCurr: 152, gasPrev: 48, gasCurr: 55 }],
    }});
    ok(r.status === 200 && r.data.readings.length === 1, 'R1: renamed back to A-101, reading intact');
  }

  // 4b. R2: optimistic concurrency — a save with a stale baseVersion is rejected (409)
  // and returns the current state, instead of silently clobbering the newer data.
  {
    const cur = (await J('/api/admin/bootstrap', { token: adminToken })).data.settings.state_version;
    const body = (ver) => ({ baseVersion: ver,
      settings: { communityName: 'Charoensap', address: 'Moo 7', currency: 'THB',
        waterRate: 18, waterFixed: 30, gasRate: 25, gasFixed: 20,
        formulaWater: '(curr - prev) * rate + fixed', formulaGas: '(curr - prev) * rate' },
      houses: [{ houseNumber: 'A-101', ownerName: 'Somchai' }],
      readings: [{ houseNumber: 'A-101', period: '2026-04', waterPrev: 135, waterCurr: 152, gasPrev: 48, gasCurr: 55 }] });
    r = await J('/api/admin/state', { method: 'PUT', token: adminToken, body: body(cur) });
    ok(r.status === 200 && r.data.settings.state_version === cur + 1, 'R2: in-sync save bumps state_version');
    // Replaying the now-stale version must conflict.
    r = await J('/api/admin/state', { method: 'PUT', token: adminToken, body: body(cur) });
    ok(r.status === 409 && r.data.houses, 'R2: stale save rejected with 409 + current state');
  }

  // 5. owner registration -> pending -> cannot log in yet
  r = await J('/api/auth/owner/register', { method: 'POST', body: { username: 'res1', password: 'pw123456', houseNumber: 'A-101' } });
  ok(r.status === 201, 'owner registered (pending)');
  r = await J('/api/auth/owner/login', { method: 'POST', body: { username: 'res1', password: 'pw123456' } });
  ok(r.status === 403 && r.data.error === 'pending', 'pending owner cannot log in');

  // 6. admin approves
  const owners = (await J('/api/admin/owners', { token: adminToken })).data;
  const ownerId = owners.find(o => o.username === 'res1').id;
  r = await J(`/api/admin/owners/${ownerId}/approve`, { method: 'POST', token: adminToken });
  ok(r.status === 200 && r.data.status === 'approved', 'admin approved owner');

  // 7. owner logs in and sees only their house's invoices
  r = await J('/api/auth/owner/login', { method: 'POST', body: { username: 'res1', password: 'pw123456' } });
  ok(r.status === 200 && r.data.token, 'approved owner logs in');
  const ownerToken = r.data.token;
  r = await J('/api/owner/bootstrap', { token: ownerToken });
  ok(r.status === 200 && r.data.house && r.data.house.houseNumber === 'A-101', 'owner sees their house');
  // After step 3, gas formula became "(curr-prev)*rate" (no fixed): 336 + 7*25 = 511.
  ok(r.data.invoices.length === 1 && Number(r.data.invoices[0].total) === 511,
    'owner sees server-recomputed total 511 (water 336 + gas 175)');

  // 8. duplicate username rejected
  r = await J('/api/auth/owner/register', { method: 'POST', body: { username: 'res1', password: 'pw123456', houseNumber: 'A-101' } });
  ok(r.status === 409, 'duplicate owner username rejected');

  // 8b. password policy (L-1): too-short passwords rejected on register/create/reset
  r = await J('/api/auth/owner/register', { method: 'POST', body: { username: 'shorty', password: 'short', houseNumber: 'A-101' } });
  ok(r.status === 400, 'register rejects password < 8 chars');
  r = await J('/api/admin/owners', { method: 'POST', token: adminToken, body: { username: 'shorty', password: 'short', houseNumber: 'A-101' } });
  ok(r.status === 400, 'admin create-owner rejects short password');
  r = await J(`/api/admin/owners/${ownerId}/password`, { method: 'POST', token: adminToken, body: { password: 'short' } });
  ok(r.status === 400, 'admin password-reset rejects short password');
  r = await J(`/api/admin/owners/${ownerId}/password`, { method: 'POST', token: adminToken, body: { password: 'longenough1' } });
  ok(r.status === 200, 'admin password-reset accepts an 8+ char password');

  // 9. brute-force lockout (H-1): admin-configurable threshold, default-style behaviour
  await resetGuard();
  r = await J('/api/admin/security', { method: 'PUT', token: adminToken, body: { maxLoginAttempts: 3, lockoutMinutes: 15 } });
  ok(r.status === 200 && r.data.max_login_attempts === 3 && r.data.login_lockout_minutes === 15,
    'admin sets lockout threshold to 3 / 15 min');
  const sb = (await J('/api/admin/bootstrap', { token: adminToken })).data.settings;
  ok(sb.max_login_attempts === 3, 'bootstrap exposes the threshold to the client');

  r = await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'nope' } });
  ok(r.status === 401, 'lockout: 1st wrong password -> 401');
  r = await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'nope' } });
  ok(r.status === 401, 'lockout: 2nd wrong password -> 401');
  r = await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'nope' } });
  ok(r.status === 429 && r.data.retryAfter > 0, 'lockout: 3rd attempt -> 429 with retryAfter');
  // While locked, even the CORRECT password is refused.
  r = await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  ok(r.status === 429, 'lockout: correct password also blocked while locked');

  // Clearing on success: a fresh client (reset) with one miss then a hit logs in fine.
  await resetGuard();
  r = await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'nope' } });
  ok(r.status === 401, 'reset: one miss -> 401');
  r = await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  ok(r.status === 200 && r.data.token, 'reset: correct password logs in (counter cleared)');

  // Threshold is clamped server-side to a sane range.
  r = await J('/api/admin/security', { method: 'PUT', token: adminToken, body: { maxLoginAttempts: 0, lockoutMinutes: 99999 } });
  ok(r.data.max_login_attempts === 1 && r.data.login_lockout_minutes === 1440,
    'security values clamped (attempts>=1, minutes<=1440)');

  // 10. admin can see and release lockouts
  await resetGuard();
  await J('/api/admin/security', { method: 'PUT', token: adminToken, body: { maxLoginAttempts: 2, lockoutMinutes: 15 } });
  await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'nope' } });
  await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'nope' } }); // -> locked
  let locked = (await J('/api/admin/security/locked', { token: adminToken })).data;
  ok(Array.isArray(locked) && locked.length === 1 && locked[0].scope === 'admin' && locked[0].retryAfter > 0,
    'admin sees the locked device');
  r = await J('/api/admin/security/unlock', { method: 'POST', token: adminToken, body: { key: locked[0].key } });
  ok(r.status === 200 && r.data.cleared === 1, 'admin unlocks the device');
  locked = (await J('/api/admin/security/locked', { token: adminToken })).data;
  ok(locked.length === 0, 'lockout list is empty after unlock');
  // The freed device can log in again immediately.
  r = await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  ok(r.status === 200 && r.data.token, 'unlocked device logs in right away');
  // unlock requires auth + a target.
  r = await J('/api/admin/security/unlock', { method: 'POST', body: { all: true } });
  ok(r.status === 401, 'unlock requires admin token');
  r = await J('/api/admin/security/unlock', { method: 'POST', token: adminToken, body: {} });
  ok(r.status === 400, 'unlock needs key or all');

  // 11. fail-closed JWT secret (L-7): importing auth.js without JWT_SECRET aborts.
  {
    const { spawnSync } = await import('node:child_process');
    const env = { ...process.env }; delete env.JWT_SECRET;
    const proc = spawnSync(process.execPath,
      ['--input-type=module', '-e', "await import('./src/auth.js')"],
      { cwd: new URL('..', import.meta.url).pathname, env, encoding: 'utf8' });
    ok(proc.status === 1 && /JWT_SECRET/.test(proc.stderr), 'auth.js refuses to start without JWT_SECRET');
  }
} catch (e) {
  fail++; console.log('  EXCEPTION', e.stack || e.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
