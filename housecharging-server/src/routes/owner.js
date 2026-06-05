import { Router } from 'express';
import { query, tx } from '../db.js';
import { requireOwner } from '../auth.js';
import { computeInvoice, publicReading } from '../invoice.js';

const router = Router();
router.use(requireOwner);

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

// Everything the owner client needs: branding + their own computed invoices.
router.get('/bootstrap', async (req, res, next) => {
  try {
    const s = (await query('SELECT * FROM settings WHERE id=1')).rows[0];
    const branding = { communityName: s.community_name, address: s.address, logo: s.logo, currency: s.currency, promptPayQr: s.promptpay_qr || null };
    const houseNumber = req.user.houseNumber;
    const house = (await query('SELECT * FROM houses WHERE lower(house_number)=lower($1)', [houseNumber])).rows[0] || null;

    let invoices = [];
    if (house) {
      const rows = (await query('SELECT * FROM readings WHERE house_id=$1 ORDER BY period DESC', [house.id])).rows;
      invoices = await tx(async (client) => {
        const list = [];
        for (const r of rows) {
          const inv = computeInvoice(r, s);
          const waterNo = await invoiceNumber(client, r.id, 'water');
          const gasNo = await invoiceNumber(client, r.id, 'gas');
          list.push({ ...publicReading(r), ...inv, waterNo, gasNo });
        }
        return list;
      });
    }
    res.json({
      branding,
      rates: { currency: s.currency, waterRate: Number(s.water_rate), waterFixed: Number(s.water_fixed), gasRate: Number(s.gas_rate), gasFixed: Number(s.gas_fixed) },
      formulaWater: s.formula_water, formulaGas: s.formula_gas,
      house: house ? { houseNumber: house.house_number, cluster: house.cluster, ownerName: house.owner_name } : null,
      invoices,
    });
  } catch (e) { next(e); }
});

// Owner views the proof-of-payment image for one of their own readings only.
router.get('/readings/:id/proof', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT r.payment_proof FROM readings r
       JOIN houses h ON h.id=r.house_id
       WHERE r.id=$1 AND lower(h.house_number)=lower($2)`,
      [req.params.id, req.user.houseNumber]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ proof: rows[0].payment_proof || null });
  } catch (e) { next(e); }
});

export default router;
