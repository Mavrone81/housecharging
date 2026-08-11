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
const J = async (path, { method = 'GET', token, body, extraHeaders } = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
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

  // 4c. R1 follow-up: renaming a house onto another house's number is rejected (409)
  // and nothing is lost (rolled back).
  {
    const baseSettings = { communityName: 'Charoensap', address: 'Moo 7', currency: 'THB',
      waterRate: 18, waterFixed: 30, gasRate: 25, gasFixed: 20,
      formulaWater: '(curr - prev) * rate + fixed', formulaGas: '(curr - prev) * rate' };
    let boot = (await J('/api/admin/bootstrap', { token: adminToken })).data;
    const aId = boot.houses.find(h => h.house_number === 'A-101').id;
    r = await J('/api/admin/state', { method: 'PUT', token: adminToken, body: {
      baseVersion: boot.settings.state_version, settings: baseSettings,
      houses: [{ id: aId, houseNumber: 'A-101', ownerName: 'Somchai' }, { houseNumber: 'B-202', ownerName: 'Malee' }],
      readings: [{ houseNumber: 'A-101', period: '2026-04', waterPrev: 135, waterCurr: 152, gasPrev: 48, gasCurr: 55 }],
    }});
    ok(r.status === 200 && r.data.houses.length === 2, 'R1c setup: a second house exists');
    boot = (await J('/api/admin/bootstrap', { token: adminToken })).data;
    const bId = boot.houses.find(h => h.house_number === 'B-202').id;
    r = await J('/api/admin/state', { method: 'PUT', token: adminToken, body: {
      baseVersion: boot.settings.state_version, settings: baseSettings,
      houses: [{ id: aId, houseNumber: 'B-202', ownerName: 'Somchai' }, { id: bId, houseNumber: 'B-202', ownerName: 'Malee' }],
      readings: [],
    }});
    ok(r.status === 409, 'R1c: renaming A-101 onto existing B-202 is rejected (409)');
    boot = (await J('/api/admin/bootstrap', { token: adminToken })).data;
    ok(boot.houses.length === 2 && boot.houses.some(h => h.house_number === 'A-101'),
      'R1c: both houses survived the rejected rename (rolled back)');
    // Clean up back to a single A-101 with its reading for the later owner steps.
    r = await J('/api/admin/state', { method: 'PUT', token: adminToken, body: {
      baseVersion: boot.settings.state_version, settings: baseSettings,
      houses: [{ id: aId, houseNumber: 'A-101', ownerName: 'Somchai' }],
      readings: [{ houseNumber: 'A-101', period: '2026-04', waterPrev: 135, waterCurr: 152, gasPrev: 48, gasCurr: 55 }],
    }});
    ok(r.status === 200 && r.data.houses.length === 1, 'R1c cleanup: back to single house A-101');
  }

  // 4d. R2 part 2: per-resource endpoints with per-row optimistic concurrency.
  {
    r = await J('/api/admin/houses', { method: 'POST', token: adminToken, body: { cluster: 'Zone C', houseNumber: 'C-303', ownerName: 'Anan' } });
    ok(r.status === 201 && r.data.id && r.data.rev === 0, 'per-resource: POST /houses creates a house (rev 0)');
    const hid = r.data.id;
    r = await J('/api/admin/houses', { method: 'POST', token: adminToken, body: { houseNumber: 'C-303' } });
    ok(r.status === 409, 'per-resource: POST /houses rejects a duplicate number');
    r = await J('/api/admin/houses/' + hid, { method: 'PUT', token: adminToken, body: { houseNumber: 'C-303', ownerName: 'Anan B.', expectedRev: 0 } });
    ok(r.status === 200 && r.data.rev === 1 && r.data.owner_name === 'Anan B.', 'per-resource: PUT /houses (correct rev) updates + bumps rev');
    r = await J('/api/admin/houses/' + hid, { method: 'PUT', token: adminToken, body: { houseNumber: 'C-303', ownerName: 'X', expectedRev: 0 } });
    ok(r.status === 409, 'per-resource: PUT /houses (stale rev) rejected (409)');
    r = await J('/api/admin/houses/' + hid, { method: 'PUT', token: adminToken, body: { houseNumber: 'A-101', expectedRev: 1 } });
    ok(r.status === 409, 'per-resource: PUT /houses rename onto an existing number rejected (409)');

    r = await J('/api/admin/readings', { method: 'POST', token: adminToken, body: { houseId: hid, period: '2026-05', waterPrev: 10, waterCurr: 20, gasPrev: 5, gasCurr: 8 } });
    ok(r.status === 200 && r.data.rev === 0, 'per-resource: POST /readings creates a reading (rev 0)');
    r = await J('/api/admin/readings', { method: 'POST', token: adminToken, body: { houseId: hid, period: '2026-05', waterPrev: 10, waterCurr: 25, gasPrev: 5, gasCurr: 9, expectedRev: 0 } });
    ok(r.status === 200 && r.data.rev === 1 && Number(r.data.water_curr) === 25, 'per-resource: POST /readings (correct rev) updates + bumps rev');
    r = await J('/api/admin/readings', { method: 'POST', token: adminToken, body: { houseId: hid, period: '2026-05', waterPrev: 10, waterCurr: 30, gasPrev: 5, gasCurr: 9, expectedRev: 0 } });
    ok(r.status === 409, 'per-resource: POST /readings (stale rev) rejected (409)');

    const sv = (await J('/api/admin/bootstrap', { token: adminToken })).data.settings.state_version;
    const setBody = (ver) => ({ baseVersion: ver, currency: 'THB', waterRate: 18, waterFixed: 30, gasRate: 25, gasFixed: 20,
      garbageFee: 0, serviceFee: 0, formulaWater: '(curr - prev) * rate + fixed', formulaGas: '(curr - prev) * rate' });
    r = await J('/api/admin/settings', { method: 'PUT', token: adminToken, body: setBody(sv) });
    ok(r.status === 200 && r.data.settings.state_version === sv + 1, 'per-resource: PUT /settings (correct version) bumps state_version');
    r = await J('/api/admin/settings', { method: 'PUT', token: adminToken, body: setBody(sv) });
    ok(r.status === 409, 'per-resource: PUT /settings (stale version) rejected (409)');

    r = await J('/api/admin/houses/' + hid, { method: 'DELETE', token: adminToken });
    ok(r.status === 200, 'per-resource: DELETE /houses removes the test house');
    const left = (await J('/api/admin/bootstrap', { token: adminToken })).data.houses;
    ok(left.length === 1 && left[0].house_number === 'A-101', 'per-resource: cleanup left only A-101');
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

  // 8. duplicate username: register gives the same generic reply (no enumeration, L-2)
  //    and must NOT create a second account.
  r = await J('/api/auth/owner/register', { method: 'POST', body: { username: 'res1', password: 'different1', houseNumber: 'A-101' } });
  ok(r.status === 201, 'duplicate username returns the generic 201 (no enumeration)');
  {
    const after = (await J('/api/admin/owners', { token: adminToken })).data.filter(o => o.username === 'res1');
    ok(after.length === 1, 'duplicate register did not create a second res1 account');
  }

  // 8b. password policy (L-1): too-short passwords rejected on register/create/reset
  r = await J('/api/auth/owner/register', { method: 'POST', body: { username: 'shorty', password: 'short', houseNumber: 'A-101' } });
  ok(r.status === 400, 'register rejects password < 8 chars');
  r = await J('/api/admin/owners', { method: 'POST', token: adminToken, body: { username: 'shorty', password: 'short', houseNumber: 'A-101' } });
  ok(r.status === 400, 'admin create-owner rejects short password');
  r = await J(`/api/admin/owners/${ownerId}/password`, { method: 'POST', token: adminToken, body: { password: 'short' } });
  ok(r.status === 400, 'admin password-reset rejects short password');
  r = await J(`/api/admin/owners/${ownerId}/password`, { method: 'POST', token: adminToken, body: { password: 'longenough1' } });
  ok(r.status === 200, 'admin password-reset accepts an 8+ char password');

  // 8c. admin edits owner data (username, house, status) via PUT /owners/:id
  r = await J(`/api/admin/owners/${ownerId}`, { method: 'PUT', token: adminToken,
    body: { username: 'res1edited', houseNumber: 'B-202', status: 'pending' } });
  ok(r.status === 200 && r.data.username === 'res1edited' && r.data.house_number === 'B-202' && r.data.status === 'pending',
    'admin edits owner username/house/status');
  // missing required fields rejected
  r = await J(`/api/admin/owners/${ownerId}`, { method: 'PUT', token: adminToken, body: { username: 'res1edited' } });
  ok(r.status === 400, 'owner edit requires username and house number');
  // invalid status rejected
  r = await J(`/api/admin/owners/${ownerId}`, { method: 'PUT', token: adminToken,
    body: { username: 'res1edited', houseNumber: 'B-202', status: 'bogus' } });
  ok(r.status === 400, 'owner edit rejects an unknown status');
  // unknown owner -> 404
  r = await J('/api/admin/owners/999999', { method: 'PUT', token: adminToken,
    body: { username: 'ghost', houseNumber: 'A-101' } });
  ok(r.status === 404, 'owner edit on unknown id returns 404');
  // username clash with another owner -> 409
  await J('/api/admin/owners', { method: 'POST', token: adminToken,
    body: { username: 'res2', password: 'pw9876543', houseNumber: 'A-101' } });
  r = await J(`/api/admin/owners/${ownerId}`, { method: 'PUT', token: adminToken,
    body: { username: 'res2', houseNumber: 'B-202' } });
  ok(r.status === 409, 'owner edit rejects a username already taken by another owner');
  // omitting status leaves it unchanged (still pending from the edit above)
  r = await J(`/api/admin/owners/${ownerId}`, { method: 'PUT', token: adminToken,
    body: { username: 'res1', houseNumber: 'A-101' } });
  ok(r.status === 200 && r.data.status === 'pending', 'owner edit without status keeps the current status');
  // restore res1 to approved/A-101 so later steps are unaffected
  r = await J(`/api/admin/owners/${ownerId}`, { method: 'PUT', token: adminToken,
    body: { username: 'res1', houseNumber: 'A-101', status: 'approved' } });
  ok(r.status === 200 && r.data.status === 'approved', 'owner edit restores res1 to approved');

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

  // 9b. The lockout key must not be forgeable, and must not be username-blind.
  //
  // Nginx builds X-Forwarded-For with $proxy_add_x_forwarded_for, which APPENDS
  // the real peer to whatever the client already sent. Any guard that reads the
  // FIRST entry is therefore reading a value the attacker chose, and can be
  // walked straight through by sending a different fake address every request.
  await resetGuard();
  await J('/api/admin/security', { method: 'PUT', token: adminToken, body: { maxLoginAttempts: 3, lockoutMinutes: 15 } });
  let spoofBlocked = false;
  for (let i = 0; i < 6; i++) {
    const rr = await J('/api/auth/admin/login', {
      method: 'POST',
      body: { username: 'admin', password: 'nope' },
      extraHeaders: { 'X-Forwarded-For': `203.0.113.${i}` },
    });
    if (rr.status === 429) { spoofBlocked = true; break; }
  }
  ok(spoofBlocked, 'lockout cannot be bypassed by forging X-Forwarded-For');

  // A lock on one username must not lock a different username from the same
  // address: otherwise five wrong guesses at a known account lock out everyone.
  await resetGuard();
  await J('/api/admin/security', { method: 'PUT', token: adminToken, body: { maxLoginAttempts: 3, lockoutMinutes: 15 } });
  for (let i = 0; i < 3; i++) {
    await J('/api/auth/admin/login', { method: 'POST', body: { username: 'someone-else', password: 'nope' } });
  }
  r = await J('/api/auth/admin/login', { method: 'POST', body: { username: 'someone-else', password: 'nope' } });
  ok(r.status === 429, 'lockout: the guessed username is locked');
  r = await J('/api/auth/admin/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  ok(r.status === 200 && r.data.token, 'lockout on one username does not lock another from the same IP');

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
