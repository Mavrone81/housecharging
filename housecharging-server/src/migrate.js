import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { pool, query } from './db.js';
import { hashPassword } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  console.log('Applying schema…');
  await query(schema);

  // Seed admin account from env (idempotent).
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
  const { rows } = await query('SELECT id FROM admins WHERE username=$1', [adminUser]);
  if (!rows.length) {
    const hash = await hashPassword(adminPass);
    await query('INSERT INTO admins (username, password_hash) VALUES ($1,$2)', [adminUser, hash]);
    console.log(`Seeded admin "${adminUser}".`);
  } else {
    console.log(`Admin "${adminUser}" already exists — left unchanged.`);
  }

  if (String(process.env.SEED_DEMO).toLowerCase() === 'true') {
    const { rows: hc } = await query('SELECT count(*)::int AS n FROM houses');
    if (hc[0].n === 0) {
      console.log('Loading demo data…');
      const houses = [
        ['Zone A', 'A-101', 'Somchai P.'],
        ['Zone A', 'A-102', 'Li Wei'],
        ['Zone B', 'B-205', 'Anong S.'],
      ];
      const ids = {};
      for (const [cluster, no, owner] of houses) {
        const r = await query(
          'INSERT INTO houses (cluster, house_number, owner_name) VALUES ($1,$2,$3) RETURNING id',
          [cluster, no, owner]);
        ids[no] = r.rows[0].id;
      }
      const readings = [
        ['A-101', '2026-03', 120, 135, 40, 48],
        ['A-101', '2026-04', 135, 152, 48, 55],
        ['A-102', '2026-04', 200, 213, 60, 64],
      ];
      for (const [no, period, wp, wc, gp, gc] of readings) {
        await query(
          `INSERT INTO readings (house_id, period, water_prev, water_curr, gas_prev, gas_curr)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [ids[no], period, wp, wc, gp, gc]);
      }
      const ownerHash = await hashPassword('owner123');
      await query(
        `INSERT INTO owners (username, password_hash, house_number, status)
         VALUES ($1,$2,$3,'approved')`,
        ['owner1', ownerHash, 'A-101']);
      console.log('Demo data loaded (owner1 / owner123, house A-101).');
    }
  }

  console.log('Migration complete.');
  await pool.end();
}

run().catch(async (e) => {
  console.error('Migration failed:', e.message);
  await pool.end();
  process.exit(1);
});
