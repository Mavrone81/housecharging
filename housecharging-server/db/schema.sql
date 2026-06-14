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
  owner_name   TEXT NOT NULL DEFAULT '',
  -- Optional per-house overrides for the community fees. NULL = use the community
  -- default from settings; a value (incl. 0) overrides it for this house.
  garbage_fee  NUMERIC,
  service_fee  NUMERIC
);

-- Per-house fee overrides (ALTER for existing databases). Nullable on purpose.
ALTER TABLE houses ADD COLUMN IF NOT EXISTS garbage_fee NUMERIC;
ALTER TABLE houses ADD COLUMN IF NOT EXISTS service_fee NUMERIC;

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
  paid          BOOLEAN NOT NULL DEFAULT false,
  paid_at       TIMESTAMPTZ,
  payment_proof TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (house_id, period)
);

-- Payment tracking columns (ALTER so existing databases pick them up on re-migrate).
ALTER TABLE readings ADD COLUMN IF NOT EXISTS paid          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE readings ADD COLUMN IF NOT EXISTS paid_at       TIMESTAMPTZ;
ALTER TABLE readings ADD COLUMN IF NOT EXISTS payment_proof TEXT;

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
  garbage_fee    NUMERIC NOT NULL DEFAULT 0,
  service_fee    NUMERIC NOT NULL DEFAULT 0,
  formula_water  TEXT NOT NULL DEFAULT '(curr - prev) * rate + fixed',
  formula_gas    TEXT NOT NULL DEFAULT '(curr - prev) * rate + fixed',
  promptpay_qr   TEXT,
  -- Brute-force protection: lock a client out after this many consecutive failed
  -- logins, for this many minutes. Admin-configurable from the Settings page.
  max_login_attempts    INTEGER NOT NULL DEFAULT 5,
  login_lockout_minutes INTEGER NOT NULL DEFAULT 15,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settings_singleton CHECK (id = 1)
);

-- PromptPay payment QR image (data URL), uploaded by the admin and shown to owners.
-- ALTER (not just the column above) so existing databases pick it up on re-migrate.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS promptpay_qr TEXT;

-- Community default garbage/service fees (per-house overrides live on houses).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS garbage_fee NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS service_fee NUMERIC NOT NULL DEFAULT 0;

-- Login brute-force lockout (ALTER so existing databases pick these up on re-migrate).
ALTER TABLE settings ADD COLUMN IF NOT EXISTS max_login_attempts    INTEGER NOT NULL DEFAULT 5;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS login_lockout_minutes INTEGER NOT NULL DEFAULT 15;

-- Monotonic version of the whole admin state, bumped on every state-sync write.
-- The client sends the version it last loaded; a mismatch means another session
-- saved in between, so the write is rejected (optimistic concurrency) instead of
-- silently clobbering the other admin's changes.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS state_version INTEGER NOT NULL DEFAULT 0;

-- Seed the singleton settings row so the app's UPDATE ... WHERE id=1 always has a target.
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Failed-login tracking for the brute-force lockout (H-1). Persisted (rather than
-- in-memory) so lockouts survive a process restart/redeploy. id is "<scope>:<ip>".
CREATE TABLE IF NOT EXISTS login_attempts (
  id           TEXT PRIMARY KEY,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Stable running invoice numbers, assigned once per (reading, utility).
CREATE SEQUENCE IF NOT EXISTS invoice_number_seq START 1001;

CREATE TABLE IF NOT EXISTS invoice_numbers (
  reading_id INTEGER NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  utility    TEXT NOT NULL,
  number     INTEGER NOT NULL,
  PRIMARY KEY (reading_id, utility)
);
