import { Router } from 'express';
import { query, tx } from '../db.js';
import { requireAdmin } from '../auth.js';
import { computeInvoice } from '../invoice.js';
import { isValidFormula, DEFAULT_FORMULA } from '../formula.js';

const router = Router();
router.use(requireAdmin);

async function getSettings() {
  const { rows } = await query('SELECT * FROM settings WHERE id=1');
  return rows[0];
}

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
    const withNums = await tx(async (client) => {
      const list = [];
      for (const r of readings) {
        const inv = computeInvoice(r, s);
        const waterNo = await invoiceNumber(client, r.id, 'water');
        const gasNo = await invoiceNumber(client, r.id, 'gas');
        list.push({ ...r, ...inv, waterNo, gasNo });
      }
      return list;
    });
    res.json({ settings: s, houses, readings: withNums, owners });
  } catch (e) { next(e); }
});

// --- Houses ---
router.post('/houses', async (req, res, next) => {
  try {
    const { cluster = '', houseNumber, ownerName = '' } = req.body || {};
    if (!houseNumber) return res.status(400).json({ error: 'House number is required' });
    const dup = await query('SELECT 1 FROM houses WHERE lower(house_number)=lower($1)', [houseNumber]);
    if (dup.rows.length) return res.status(409).json({ error: 'House number already exists' });
    const { rows } = await query(
      'INSERT INTO houses (cluster, house_number, owner_name) VALUES ($1,$2,$3) RETURNING *',
      [cluster, houseNumber, ownerName]);
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

router.put('/houses/:id', async (req, res, next) => {
  try {
    const { cluster = '', houseNumber, ownerName = '' } = req.body || {};
    if (!houseNumber) return res.status(400).json({ error: 'House number is required' });
    const { rows } = await query(
      'UPDATE houses SET cluster=$1, house_number=$2, owner_name=$3 WHERE id=$4 RETURNING *',
      [cluster, houseNumber, ownerName, req.params.id]);
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
         formula_water=$6, formula_gas=$7, updated_at=now() WHERE id=1 RETURNING *`,
      [b.currency || 'THB', num(b.waterRate, 0), num(b.waterFixed, 0),
       num(b.gasRate, 0), num(b.gasFixed, 0), fw, fg]);
    res.json({ settings: rows[0], formulaWaterValid: fw === b.formulaWater, formulaGasValid: fg === b.formulaGas });
  } catch (e) { next(e); }
});

// --- Branding ---
router.put('/branding', async (req, res, next) => {
  try {
    const b = req.body || {};
    const logo = b.logo === undefined ? undefined : (b.logo || null);
    const sets = ['community_name=$1', 'address=$2', 'updated_at=now()'];
    const params = [b.communityName || 'MCTS', b.address || ''];
    if (logo !== undefined) { sets.splice(2, 0, 'logo=$3'); params.push(logo); }
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
    res.json({ ...rows[0], ...computeInvoice(rows[0], s) });
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
    const sql = `SELECT r.*, h.house_number, h.cluster, h.owner_name
                 FROM readings r JOIN houses h ON h.id=r.house_id
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY r.period DESC, h.house_number`;
    const rows = (await query(sql, params)).rows;
    const out = await tx(async (client) => {
      const list = [];
      for (const r of rows) {
        const inv = computeInvoice(r, s);
        const waterNo = await invoiceNumber(client, r.id, 'water');
        const gasNo = await invoiceNumber(client, r.id, 'gas');
        list.push({ ...r, ...inv, waterNo, gasNo });
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
           formula_water=$9, formula_gas=$10, updated_at=now() WHERE id=1`,
        [s.communityName || 'MCTS', s.address || '', s.logo ?? null, s.currency || 'THB',
         num(s.waterRate, 0), num(s.waterFixed, 0), num(s.gasRate, 0), num(s.gasFixed, 0), fw, fg]);

      const houses = Array.isArray(b.houses) ? b.houses : [];
      const keep = [];
      const idByNo = {};
      for (const h of houses) {
        if (!h.houseNumber) continue;
        const r = await client.query(
          `INSERT INTO houses (cluster, house_number, owner_name) VALUES ($1,$2,$3)
           ON CONFLICT (house_number) DO UPDATE SET cluster=EXCLUDED.cluster, owner_name=EXCLUDED.owner_name
           RETURNING id, house_number`,
          [h.cluster || '', h.houseNumber, h.ownerName || '']);
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
      const list = [];
      for (const r of rrows) {
        const inv = computeInvoice(r, settings);
        const waterNo = await invoiceNumber(client, r.id, 'water');
        const gasNo = await invoiceNumber(client, r.id, 'gas');
        list.push({ ...r, ...inv, waterNo, gasNo });
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
