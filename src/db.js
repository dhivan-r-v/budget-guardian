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
