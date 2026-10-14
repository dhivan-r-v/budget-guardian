import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const DB_PATH = process.env.DB_PATH ?? path.resolve('data', 'budget-guardian.db');

// Money is stored as integer cents so totals never drift from float rounding.
// `category` / `is_recurring` are filled by the LLM categorizer.
// `seed_category` / `seed_recurring` are ground truth from the seed script,
// used only to check the categorizer's accuracy.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id             TEXT PRIMARY KEY,
  occurred_at    TEXT    NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  currency       TEXT    NOT NULL DEFAULT 'USD',
  merchant       TEXT    NOT NULL,
  description    TEXT,
  source         TEXT    NOT NULL CHECK (source IN ('seed', 'paypal')),
  category       TEXT,
  is_recurring   INTEGER,
  seed_category  TEXT,
  seed_recurring INTEGER,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_transactions_occurred_at ON transactions (occurred_at);

-- Categories the user has marked as flexible (willing to cut). Savings are only
-- suggested for these; the AI never decides what is a need or a want.
CREATE TABLE IF NOT EXISTS category_prefs (
  category TEXT PRIMARY KEY,
  flexible INTEGER NOT NULL CHECK (flexible IN (0, 1))
);

-- Savings options the user approved, and what happened at PayPal. Written before any money
-- moves. status: approved (not sent yet, or sending failed in a way that is safe to retry
-- with the same id), sent (PayPal accepted the payout), completed, failed (PayPal refused).
CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  option_id       TEXT    NOT NULL,
  category        TEXT    NOT NULL,
  month           TEXT    NOT NULL,
  description     TEXT    NOT NULL,
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
  receiver        TEXT    NOT NULL,
  status          TEXT    NOT NULL CHECK (status IN ('approved', 'sent', 'completed', 'failed')),
  payout_batch_id TEXT,
  paypal_status   TEXT,
  error           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
-- At most one live approval per option per month, so a double click can't pay twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_one_per_month
  ON approvals (option_id, month) WHERE status != 'failed';

-- Small key/value state: last PayPal sync, how far PayPal's data is refreshed, the date the
-- demo history was generated through.
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Validated LLM responses, keyed by a hash of model + prompt version + input facts,
-- so identical facts never spend API quota twice.
CREATE TABLE IF NOT EXISTS ai_cache (
  key        TEXT PRIMARY KEY,
  model      TEXT NOT NULL,
  response   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
`;

export function openDb(file = DB_PATH) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}
