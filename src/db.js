import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const DB_PATH = process.env.DB_PATH ?? path.resolve('data', 'budget-guardian.db');

// Money is stored as integer cents so totals never drift from float rounding.
// `category` / `is_recurring` are filled by the LLM categorizer.
// `seed_category` / `seed_recurring` are ground truth from the seed script,
// used only to check the categorizer's accuracy.
// source: seed (demo history), paypal (Transaction Search), statement (an uploaded bank or
// card statement; import_id says which upload).
const TRANSACTIONS = `
CREATE TABLE IF NOT EXISTS transactions (
  id             TEXT PRIMARY KEY,
  occurred_at    TEXT    NOT NULL,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  currency       TEXT    NOT NULL DEFAULT 'USD',
  merchant       TEXT    NOT NULL,
  description    TEXT,
  source         TEXT    NOT NULL CHECK (source IN ('seed', 'paypal', 'statement')),
  category       TEXT,
  is_recurring   INTEGER,
  seed_category  TEXT,
  seed_recurring INTEGER,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  import_id      TEXT
)`;
const TRANSACTION_COLUMNS = 'id, occurred_at, amount_cents, currency, merchant, description, source, category, is_recurring, seed_category, seed_recurring, created_at';

const SCHEMA = `
${TRANSACTIONS};
CREATE INDEX IF NOT EXISTS idx_transactions_occurred_at ON transactions (occurred_at);

-- Uploaded statements, so an upload can be listed and removed again.
CREATE TABLE IF NOT EXISTS statement_imports (
  id          TEXT PRIMARY KEY,
  filename    TEXT    NOT NULL,
  rows_added  INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  first_date  TEXT,
  last_date   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

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

-- The user's own settings (e.g. monthly budget). Kept apart from sync_state, which the app
-- writes on its own.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Small key/value state: last PayPal sync, how far PayPal's data is refreshed, the date the
-- demo history was generated through.
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Alerts shown on the user's devices (Web Push): spikes, plans going over. The key makes
-- each alert exist once, e.g. spike:fuel:2026-10; deliveries track it per device.
DROP TABLE IF EXISTS alerts;
CREATE TABLE IF NOT EXISTS notifications (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  category   TEXT,
  month      TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
-- Devices (browsers) that turned alerts on.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
-- status: sending, sent, failed (retried up to 3 attempts).
CREATE TABLE IF NOT EXISTS notification_deliveries (
  key      TEXT    NOT NULL,
  endpoint TEXT    NOT NULL,
  status   TEXT    NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error    TEXT,
  sent_at  TEXT,
  PRIMARY KEY (key, endpoint)
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

// Columns added after the first release, for databases created before them.
// The plan columns record what the user committed to, so follow-through can be checked:
// plan_since (ISO time the plan started), plan_allowance_cents (one-off spending the plan
// allows in its category until month end), plan_merchants (JSON: subscriptions to skip).
const ADDED_COLUMNS = {
  approvals: { plan_since: 'TEXT', plan_allowance_cents: 'INTEGER', plan_merchants: 'TEXT' },
};

export function openDb(file = DB_PATH) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  // Databases from before statement uploads: SQLite can't change a CHECK constraint, so the
  // transactions table is rebuilt with the new one (and the import_id column).
  const tx = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transactions'").get();
  if (!tx.sql.includes("'statement'")) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE transactions RENAME TO transactions_old');
      db.exec(TRANSACTIONS);
      db.exec(`INSERT INTO transactions (${TRANSACTION_COLUMNS}) SELECT ${TRANSACTION_COLUMNS} FROM transactions_old`);
      db.exec('DROP TABLE transactions_old');
      db.exec('CREATE INDEX IF NOT EXISTS idx_transactions_occurred_at ON transactions (occurred_at)');
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [col, type] of Object.entries(cols)) if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  return db;
}
