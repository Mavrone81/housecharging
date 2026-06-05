-- MCTS Community Utility Billing — PostgreSQL schema.
-- Idempotent: migrate.js applies this on every deploy, so everything uses IF NOT EXISTS
-- and the seed rows use ON CONFLICT DO NOTHING.

-- Admin accounts (seeded from ADMIN_USERNAME/ADMIN_PASSWORD by migrate.js).
CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Resident/owner accounts. Self-register as 'pending'; an admin approves/rejects.
CREATE TABLE IF NOT EXISTS owners (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  house_number  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Houses in the community. house_number is the natural key used by the state sync
-- (ON CONFLICT (house_number)) and to link owners to their invoices.
CREATE TABLE IF NOT EXISTS houses (
  id           SERIAL PRIMARY KEY,
  cluster      TEXT NOT NULL DEFAULT '',
  house_number TEXT NOT NULL UNIQUE,
  owner_name   TEXT NOT NULL DEFAULT ''
);

-- Per-period meter readings. One row per (house, period). Deleting a house drops
-- its readings (cascade) — matches the README note about renaming a house.
CREATE TABLE IF NOT EXISTS readings (
  id         SERIAL PRIMARY KEY,
  house_id   INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  period     TEXT NOT NULL,
  water_prev NUMERIC NOT NULL DEFAULT 0,
  water_curr NUMERIC NOT NULL DEFAULT 0,
  gas_prev   NUMERIC NOT NULL DEFAULT 0,
  gas_curr   NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (house_id, period)
);

-- Single-row settings table (always id=1): branding, rates and billing formulas.
CREATE TABLE IF NOT EXISTS settings (
  id             INTEGER PRIMARY KEY DEFAULT 1,
  community_name TEXT NOT NULL DEFAULT 'MCTS',
  address        TEXT NOT NULL DEFAULT '',
  logo           TEXT,
  currency       TEXT NOT NULL DEFAULT 'THB',
  water_rate     NUMERIC NOT NULL DEFAULT 0,
  water_fixed    NUMERIC NOT NULL DEFAULT 0,
  gas_rate       NUMERIC NOT NULL DEFAULT 0,
  gas_fixed      NUMERIC NOT NULL DEFAULT 0,
  formula_water  TEXT NOT NULL DEFAULT '(curr - prev) * rate + fixed',
  formula_gas    TEXT NOT NULL DEFAULT '(curr - prev) * rate + fixed',
  promptpay_qr   TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settings_singleton CHECK (id = 1)
);

-- PromptPay payment QR image (data URL), uploaded by the admin and shown to owners.
-- ALTER (not just the column above) so existing databases pick it up on re-migrate.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS promptpay_qr TEXT;

-- Seed the singleton settings row so the app's UPDATE ... WHERE id=1 always has a target.
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Stable running invoice numbers, assigned once per (reading, utility).
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1001;

CREATE TABLE IF NOT EXISTS invoice_numbers (
  reading_id INTEGER NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  utility    TEXT NOT NULL,
  number     INTEGER NOT NULL,
  PRIMARY KEY (reading_id, utility)
);
