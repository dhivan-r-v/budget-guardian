// Per-visitor demo: each visitor gets their own copy of the demo, so what one judge does
// (approve a plan, upload a statement, connect a bank, turn on alerts) never changes what the
// next one sees.
//
// A workspace is a small SQLite file of its own, seeded with the demo history on the first
// visit and found again through a cookie. The shared database is attached to each one: it
// holds the AI cache (so the same facts never cost AI quota twice, whoever asks), the PayPal
// sync (there is one sandbox account) and the list of workspaces. Workspaces idle for
// IDLE_DAYS are deleted, and beyond MAX_WORKSPACES the least recently used one goes.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { seedDemoIfStale } from './seed.js';
import { today } from './spikes.js';

const MAX_WORKSPACES = 300;
const MAX_OPEN = 100; // open database connections kept in memory (closing one mid-job would break it)
const IDLE_DAYS = 14;
const ID = /^[0-9a-f]{32}$/;

const COPY_COLUMNS = 'id, occurred_at, amount_cents, currency, merchant, description, source, category, is_recurring, created_at';

// The shared PayPal history, copied into a workspace (labels too, unless the workspace
// already has its own).
export function copyPayPal(db) {
  db.exec(`
    INSERT INTO main.transactions (${COPY_COLUMNS})
    SELECT ${COPY_COLUMNS} FROM shared.transactions WHERE source = 'paypal' AND true
    ON CONFLICT (id) DO UPDATE SET
      category = COALESCE(category, excluded.category),
      is_recurring = COALESCE(is_recurring, excluded.is_recurring)
  `);
}

export function createWorkspaces({ shared, sharedFile, dir, maxWorkspaces = MAX_WORKSPACES, idleDays = IDLE_DAYS, now = () => new Date() }) {
  mkdirSync(dir, { recursive: true });
  shared.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id           TEXT PRIMARY KEY,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    -- Which workspace connected a Plaid item, so Plaid's webhook syncs the right one.
    CREATE TABLE IF NOT EXISTS plaid_item_workspaces (
      item_id      TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL
    );
  `);
  const open = new Map(); // id -> db, in least-recently-used order
  const fileOf = (id) => path.join(dir, `${id}.db`);
  const iso = () => now().toISOString().slice(0, 19) + 'Z';

  function connect(id) {
    if (open.has(id)) {
      const db = open.get(id);
      open.delete(id);
      open.set(id, db);
      return db;
    }
    const db = openDb(fileOf(id), { shared: sharedFile });
    open.set(id, db);
    while (open.size > MAX_OPEN) {
      const [oldest, odb] = open.entries().next().value;
      open.delete(oldest);
      odb.close();
    }
    return db;
  }

  function remove(id) {
    if (!ID.test(id ?? '')) return;
    open.get(id)?.close();
    open.delete(id);
    for (const suffix of ['', '-wal', '-shm']) rmSync(fileOf(id) + suffix, { force: true });
    shared.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    shared.prepare('DELETE FROM plaid_item_workspaces WHERE workspace_id = ?').run(id);
  }

  function create() {
    const id = randomBytes(16).toString('hex');
    const db = connect(id);
    seedDemoIfStale(db, { end: today() });
    copyPayPal(db);
    shared.prepare('INSERT INTO workspaces (id, created_at, last_seen_at) VALUES (?, ?, ?)').run(id, iso(), iso());
    const extra = shared.prepare('SELECT id FROM workspaces ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?').all(maxWorkspaces);
    for (const w of extra) remove(w.id);
    return { id, db, created: true };
  }

  // The visitor's workspace, or null if the cookie's id is unknown (expired, or made up).
  function get(id) {
    if (!ID.test(id ?? '')) return null;
    const row = shared.prepare('SELECT last_seen_at FROM workspaces WHERE id = ?').get(id);
    if (!row || !existsSync(fileOf(id))) return null;
    // Record the visit at most once a minute.
    if (Date.parse(iso()) - Date.parse(row.last_seen_at) > 60_000) shared.prepare('UPDATE workspaces SET last_seen_at = ? WHERE id = ?').run(iso(), id);
    return { id, db: connect(id), created: false };
  }

  // Workspaces visited in the last `hours`, for background syncs and alerts.
  function active(hours = 48) {
    const since = new Date(now().getTime() - hours * 3_600_000).toISOString().slice(0, 19) + 'Z';
    return shared.prepare('SELECT id FROM workspaces WHERE last_seen_at >= ? ORDER BY last_seen_at DESC').all(since)
      .map((w) => ({ id: w.id, db: connect(w.id) }));
  }

  function cleanup() {
    const before = new Date(now().getTime() - idleDays * 86_400_000).toISOString().slice(0, 19) + 'Z';
    const idle = shared.prepare('SELECT id FROM workspaces WHERE last_seen_at < ?').all(before);
    for (const w of idle) remove(w.id);
    return idle.length;
  }

  const ownerOfItem = (itemId) => shared.prepare('SELECT workspace_id FROM plaid_item_workspaces WHERE item_id = ?').get(itemId)?.workspace_id ?? null;
  const setItemOwner = (itemId, workspaceId) =>
    shared.prepare('INSERT INTO plaid_item_workspaces (item_id, workspace_id) VALUES (?, ?) ON CONFLICT (item_id) DO UPDATE SET workspace_id = excluded.workspace_id').run(itemId, workspaceId);
  const count = () => shared.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n;

  // Closes every open workspace database (on shutdown, and in tests).
  function closeAll() {
    for (const db of open.values()) db.close();
    open.clear();
  }

  return { create, get, remove, active, cleanup, ownerOfItem, setItemOwner, count, closeAll };
}
