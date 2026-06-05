import { Router } from 'express';
import { query, tx } from '../db.js';
import { requireAdmin, hashPassword } from '../auth.js';
import { computeInvoice, publicReading } from '../invoice.js';
import { isValidFormula, DEFAULT_FORMULA } from '../formula.js';
import { listLocked, unlock, unlockAll } from '../loginGuard.js';

const router = Router();
router.use(requireAdmin);

async function getSettings() {
  const { rows } = await query('SELECT * FROM settings WHERE id=1');
  return rows[0];
}

// Map house id -> per-house fee overrides, for computeInvoice.
const feeMap = (houses) => Object.fromEntries(
  houses.map(h => [h.id, { garbage: h.garbage_fee, service: h.service_fee }]));

// Assign/fetch a stable running invoice number for (reading, utility).
async function invoiceNumber(client, readingId, utility) {
  const found = await client.query(
    'SELECT number FROM invoice_numbers WHERE reading_id=$1 AND utility=$2', [readingId, utility]);
  if (found.rows.length) return found.rows[0].number;
  const seq = await client.query("SELECT nextval('invoice_number_seq') AS n");
  const number = Number(seq.rows[0].n);
  await client.query(
    'INSERT INTO invoice_numbers (reading_id, utility, number) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [readingId, utility, number]);
  return number;
}

// --- Bootstrap: everything the admin client needs in one call ---
router.get('/bootstrap', async (_req, res, next) => {
  try {
    const s = await getSettings();
    const houses = (await query('SELECT * FROM houses ORDER BY house_number')).rows;
    const readings = (await query('SELECT * FROM readings ORDER BY period DESC, id DESC')).rows;
    const owners = (await query('SELECT id, username, house_number, status, created_at FROM owners ORDER BY created_at')).rows;
    const fees = feeMap(houses);
    const withNums = await tx(async (client) => {
      const list = [];
      for (const r of readings) {
        const inv = computeInvoice(r, s, fees[r.house_id]);
        const waterNo = await invoiceNumber(client, r.id, 'water');
        const gasNo = await invoiceNumber(client, r.id, 'gas');
        list.push({ ...publicReading(r), ...inv, waterNo, gasNo });
      }
      return list;
    });
    res.json({ settings: s, houses, readings: withNums, owners });
  } catch (e) { next(e); }
});

// --- Houses ---
// Per-house fee override: blank/null/undefined => null (inherit community default).
const feeOverride = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

router.post('/houses', async (req, res, next) => {
  try {
    const { cluster = '', houseNumber, ownerName = '' } = req.body || {};
    if (!houseNumber) return res.status(400).json({ error: 'House number is required' });
    const dup = await query('SELECT 1 FROM houses WHERE lower(house_number)=lower($1)', [houseNumber]);
    if (dup.rows.length) return res.status(409).json({ error: 'House number already exists' });
    const { rows } = await query(
      'INSERT INTO houses (cluster, house_number, owner_name, garbage_fee, service_fee) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [cluster, houseNumber, ownerName, feeOverride(req.body.garbageFee), feeOverride(req.body.serviceFee)]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

router.put('/houses/:id', async (req, res, next) => {
  try {
    const { cluster = '', houseNumber, ownerName = '' } = req.body || {};
    if (!houseNumber) return res.status(400).json({ error: 'House number is required' });
    const { rows } = await query(
      'UPDATE houses SET cluster=$1, house_number=$2, owner_name=$3, garbage_fee=$4, service_fee=$5 WHERE id=$6 RETURNING *',
      [cluster, houseNumber, ownerName, feeOverride(req.body.garbageFee), feeOverride(req.body.serviceFee), req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'House not found' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.delete('/houses/:id', async (req, res, next) => {
  try {
    await query('DELETE FROM houses WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// --- Rates + formula ---
router.put('/settings', async (req, res, next) => {
  try {
    const b = req.body || {};
    const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
    const fw = typeof b.formulaWater === 'string' && isValidFormula(b.formulaWater) ? b.formulaWater : DEFAULT_FORMULA;
    const fg = typeof b.formulaGas === 'string' && isValidFormula(b.formulaGas) ? b.formulaGas : DEFAULT_FORMULA;
    const { rows } = await query(
      `UPDATE settings SET currency=$1, water_rate=$2, water_fixed=$3, gas_rate=$4, gas_fixed=$5,
         formula_water=$6, formula_gas=$7, garbage_fee=$8, service_fee=$9, updated_at=now() WHERE id=1 RETURNING *`,
      [b.currency || 'THB', num(b.waterRate, 0), num(b.waterFixed, 0),
       num(b.gasRate, 0), num(b.gasFixed, 0), fw, fg, num(b.garbageFee, 0), num(b.serviceFee, 0)]);
    res.json({ settings: rows[0], formulaWaterValid: fw === b.formulaWater, formulaGasValid: fg === b.formulaGas });
  } catch (e) { next(e); }
});

// --- Login security (admin-configurable brute-force lockout) ---
router.put('/security', async (req, res, next) => {
  try {
    const b = req.body || {};
    const clamp = (v, d, lo, hi) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    };
    const maxAttempts = clamp(b.maxLoginAttempts, 5, 1, 100);
    const lockoutMin = clamp(b.lockoutMinutes, 15, 1, 1440);
    const { rows } = await query(
      `UPDATE settings SET max_login_attempts=$1, login_lockout_minutes=$2, updated_at=now()
       WHERE id=1 RETURNING *`,
      [maxAttempts, lockoutMin]);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// Currently locked-out clients (devices that hit the failed-login threshold).
router.get('/security/locked', (_req, res) => {
  res.json(listLocked());
});

// Release a lockout: { key } for one client, or { all: true } for everyone.
router.post('/security/unlock', (req, res) => {
  const b = req.body || {};
  if (b.all) return res.json({ cleared: unlockAll() });
  if (!b.key) return res.status(400).json({ error: 'key or all is required' });
  res.json({ cleared: unlock(b.key) ? 1 : 0 });
});

// --- Branding ---
router.put('/branding', async (req, res, next) => {
  try {
    const b = req.body || {};
    const logo = b.logo === undefined ? undefined : (b.logo || null);
    const sets = ['community_name=$1', 'address=$2', 'updated_at=now()'];
    const params = [b.communityName || 'MCTS', b.address || ''];
    if (logo !== undefined) { sets.splice(sets.length - 1, 0, `logo=$${params.length + 1}`); params.push(logo); }
    if (b.promptPayQr !== undefined) { sets.splice(sets.length - 1, 0, `promptpay_qr=$${params.length + 1}`); params.push(b.promptPayQr || null); }
    const { rows } = await query(`UPDATE settings SET ${sets.join(', ')} WHERE id=1 RETURNING *`, params);
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// --- Readings (upsert by house+period) ---
router.post('/readings', async (req, res, next) => {
  try {
    const b = req.body || {};
    const n = v => Number(v) || 0;
    if (!b.houseId || !b.period) return res.status(400).json({ error: 'house and period required' });
    const wp = n(b.waterPrev), gp = n(b.gasPrev);
    const wc = (b.waterCurr === '' || b.waterCurr == null) ? wp : n(b.waterCurr);
    const gc = (b.gasCurr === '' || b.gasCurr == null) ? gp : n(b.gasCurr);
    if (wc < wp || gc < gp) return res.status(400).json({ error: 'Current reading must be ≥ previous' });
    const { rows } = await query(
      `INSERT INTO readings (house_id, period, water_prev, water_curr, gas_prev, gas_curr)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (house_id, period) DO UPDATE
         SET water_prev=EXCLUDED.water_prev, water_curr=EXCLUDED.water_curr,
             gas_prev=EXCLUDED.gas_prev, gas_curr=EXCLUDED.gas_curr, updated_at=now()
       RETURNING *`,
      [b.houseId, b.period, wp, wc, gp, gc]);
    const s = await getSettings();
    const hf = (await query('SELECT garbage_fee, service_fee FROM houses WHERE id=$1', [b.houseId])).rows[0] || {};
    res.json({ ...rows[0], ...computeInvoice(rows[0], s, { garbage: hf.garbage_fee, service: hf.service_fee }) });
  } catch (e) { next(e); }
});

// --- Payments: mark a month paid/unpaid and/or attach a proof-of-payment image ---
router.post('/readings/:id/payment', async (req, res, next) => {
  try {
    const b = req.body || {};
    const sets = [];
    const params = [];
    if (b.paid !== undefined) {
      params.push(!!b.paid); sets.push(`paid=$${params.length}`);
      sets.push(`paid_at=${b.paid ? 'now()' : 'NULL'}`);
    }
    if (b.proof !== undefined) { params.push(b.proof || null); sets.push(`payment_proof=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE readings SET ${sets.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: 'Reading not found' });
    res.json(publicReading(rows[0]));
  } catch (e) { next(e); }
});

// Fetch the full proof-of-payment image for one reading (kept out of list payloads).
router.get('/readings/:id/proof', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT payment_proof FROM readings WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Reading not found' });
    res.json({ proof: rows[0].payment_proof || null });
  } catch (e) { next(e); }
});

// --- Invoices (computed, with stable numbers) ---
router.get('/invoices', async (req, res, next) => {
  try {
    const s = await getSettings();
    const params = [];
    const where = [];
    if (req.query.house && req.query.house !== 'all') { params.push(req.query.house); where.push(`r.house_id=$${params.length}`); }
    if (req.query.period && req.query.period !== 'all') { params.push(req.query.period); where.push(`r.period=$${params.length}`); }
    const sql = `SELECT r.*, h.house_number, h.cluster, h.owner_name, h.garbage_fee, h.service_fee
                 FROM readings r JOIN houses h ON h.id=r.house_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY r.period DESC, h.house_number`;
    const rows = (await query(sql, params)).rows;
    const out = await tx(async (client) => {
      const list = [];
      for (const r of rows) {
        const inv = computeInvoice(r, s, { garbage: r.garbage_fee, service: r.service_fee });
        const waterNo = await invoiceNumber(client, r.id, 'water');
        const gasNo = await invoiceNumber(client, r.id, 'gas');
        list.push({ ...publicReading(r), ...inv, waterNo, gasNo });
      }
      return list;
    });
    res.json({ settings: s, invoices: out });
  } catch (e) { next(e); }
});

// --- Whole-state sync (houses + readings + settings) used by the web client ---
router.put('/state', async (req, res, next) => {
  try {
    const b = req.body || {};
    const s = b.settings || {};
    const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
    const fw = typeof s.formulaWater === 'string' && isValidFormula(s.formulaWater) ? s.formulaWater : DEFAULT_FORMULA;
    const fg = typeof s.formulaGas === 'string' && isValidFormula(s.formulaGas) ? s.formulaGas : DEFAULT_FORMULA;

    const out = await tx(async (client) => {
      await client.query(
        `UPDATE settings SET community_name=$1, address=$2, logo=$3, currency=$4,
           water_rate=$5, water_fixed=$6, gas_rate=$7, gas_fixed=$8,
           formula_water=$9, formula_gas=$10, promptpay_qr=$11, garbage_fee=$12, service_fee=$13,
           updated_at=now() WHERE id=1`,
        [s.communityName || 'MCTS', s.address || '', s.logo ?? null, s.currency || 'THB',
         num(s.waterRate, 0), num(s.waterFixed, 0), num(s.gasRate, 0), num(s.gasFixed, 0), fw, fg,
         s.promptPayQr ?? null, num(s.garbageFee, 0), num(s.serviceFee, 0)]);

      const houses = Array.isArray(b.houses) ? b.houses : [];
      const keep = [];
      const idByNo = {};
      const ovr = v => (v === undefined || v === null || v === '' ? null : Number(v));
      for (const h of houses) {
        if (!h.houseNumber) continue;
        const r = await client.query(
          `INSERT INTO houses (cluster, house_number, owner_name, garbage_fee, service_fee) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (house_number) DO UPDATE SET cluster=EXCLUDED.cluster, owner_name=EXCLUDED.owner_name,
             garbage_fee=EXCLUDED.garbage_fee, service_fee=EXCLUDED.service_fee
           RETURNING id, house_number`,
          [h.cluster || '', h.houseNumber, h.ownerName || '', ovr(h.garbageFee), ovr(h.serviceFee)]);
        keep.push(r.rows[0].house_number);
        idByNo[String(r.rows[0].house_number).toLowerCase()] = r.rows[0].id;
      }
      if (keep.length) await client.query('DELETE FROM houses WHERE NOT (house_number = ANY($1::text[]))', [keep]);
      else await client.query('DELETE FROM houses');

      const readings = Array.isArray(b.readings) ? b.readings : [];
      for (const r of readings) {
        const hid = idByNo[String(r.houseNumber || '').toLowerCase()];
        if (!hid || !r.period) continue;
        const n = v => Number(v) || 0;
        const wp = n(r.waterPrev), gp = n(r.gasPrev);
        const wc = (r.waterCurr === '' || r.waterCurr == null) ? wp : n(r.waterCurr);
        const gc = (r.gasCurr === '' || r.gasCurr == null) ? gp : n(r.gasCurr);
        await client.query(
          `INSERT INTO readings (house_id, period, water_prev, water_curr, gas_prev, gas_curr)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (house_id, period) DO UPDATE SET water_prev=EXCLUDED.water_prev,
             water_curr=EXCLUDED.water_curr, gas_prev=EXCLUDED.gas_prev, gas_curr=EXCLUDED.gas_curr, updated_at=now()`,
          [hid, r.period, wp, wc, gp, gc]);
      }

      const settings = (await client.query('SELECT * FROM settings WHERE id=1')).rows[0];
      const hrows = (await client.query('SELECT * FROM houses ORDER BY house_number')).rows;
      const rrows = (await client.query('SELECT * FROM readings ORDER BY period DESC, id DESC')).rows;
      const fees = feeMap(hrows);
      const list = [];
      for (const r of rrows) {
        const inv = computeInvoice(r, settings, fees[r.house_id]);
        const waterNo = await invoiceNumber(client, r.id, 'water');
        const gasNo = await invoiceNumber(client, r.id, 'gas');
        list.push({ ...publicReading(r), ...inv, waterNo, gasNo });
      }
      return { settings, houses: hrows, readings: list };
    });
    res.json(out);
  } catch (e) { next(e); }
});

// --- Owner approvals ---
router.get('/owners', async (_req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, username, house_number, status, created_at FROM owners ORDER BY created_at');
    res.json(rows);
  } catch (e) { next(e); }
});

// Admin creates an owner account directly (approved by default, ready to log in).
router.post('/owners', async (req, res, next) => {
  try {
    const { username, password, houseNumber } = req.body || {};
    if (!username || !password || !houseNumber)
      return res.status(400).json({ error: 'Username, password and house number are required' });
    const status = req.body.status === 'pending' ? 'pending' : 'approved';
    const exists = await query('SELECT 1 FROM owners WHERE lower(username)=lower($1)', [username]);
    if (exists.rows.length) return res.status(409).json({ error: 'Username already taken' });
    const hash = await hashPassword(password);
    const { rows } = await query(
      `INSERT INTO owners (username, password_hash, house_number, status)
       VALUES ($1,$2,$3,$4) RETURNING id, username, house_number, status, created_at`,
      [username, hash, houseNumber, status]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

// Admin resets an owner's password. (Defined before /:action so it isn't shadowed.)
router.post('/owners/:id/password', async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'A new password is required' });
    const hash = await hashPassword(password);
    const { rows } = await query(
      'UPDATE owners SET password_hash=$1 WHERE id=$2 RETURNING id, username, house_number, status',
      [hash, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Owner not found' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.post('/owners/:id/:action', async (req, res, next) => {
  try {
    const map = { approve: 'approved', reject: 'rejected' };
    const status = map[req.params.action];
    if (!status) return res.status(400).json({ error: 'Unknown action' });
    const { rows } = await query(
      'UPDATE owners SET status=$1 WHERE id=$2 RETURNING id, username, house_number, status',
      [status, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Owner not found' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

export default router;
