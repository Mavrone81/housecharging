import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Copy .env.example to .env and configure it.');
  process.exit(1);
}

const ssl = String(process.env.PGSSL).toLowerCase() === 'true'
  ? { rejectUnauthorized: false }
  : false;

export let pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: 10,
  idleTimeoutMillis: 30000,
});

// Test-only: allow injecting an alternate pool (e.g. an in-memory Postgres for tests).
export function setPool(p) { pool = p; }

export const query = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
