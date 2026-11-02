import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createWorkspaces, copyPayPal } from '../src/workspaces.js';
import { detectSpikes } from '../src/spikes.js';
import { getBudget, setBudget } from '../src/budget.js';

function setup(opts = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bg-ws-'));
  const sharedFile = path.join(dir, 'shared.db');
  const shared = openDb(sharedFile);
  let clock = new Date('2026-11-02T10:00:00Z');
  const ws = createWorkspaces({ shared, sharedFile, dir: path.join(dir, 'workspaces'), now: () => clock, ...opts });
  return { dir, shared, ws, tick: (ms) => { clock = new Date(clock.getTime() + ms); }, done: () => { ws.closeAll(); shared.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const addPayPal = (db, id, category = null) =>
  db.prepare(`INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, category, is_recurring) VALUES (?, '2026-11-01T09:00:00Z', 4820, 'Shell', 'paypal', ?, 0)`).run(id, category);

test('each visitor gets their own seeded demo; changes stay in it', () => {
  const t = setup();
  try {
    const a = t.ws.create();
    const b = t.ws.create();
    assert.match(a.id, /^[0-9a-f]{32}$/);
    assert.notEqual(a.id, b.id);
    // Seeded like the demo: history, flexible categories, budget.
    assert.ok(a.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'seed'").get().n > 100);
    assert.equal(getBudget(a.db), 110000);
    assert.ok(detectSpikes(a.db).categories.length > 0);

    setBudget(a.db, 90000);
    assert.equal(getBudget(a.db), 90000);
    assert.equal(getBudget(b.db), 110000);
    assert.equal(t.ws.get(a.id).db, a.db);
    assert.equal(t.ws.count(), 2);
  } finally {
    t.done();
  }
});

test('unknown or malformed ids get no workspace', () => {
  const t = setup();
  try {
    assert.equal(t.ws.get(undefined), null);
    assert.equal(t.ws.get('../../etc/passwd'), null);
    assert.equal(t.ws.get('0'.repeat(32)), null);
  } finally {
    t.done();
  }
});

test('the AI cache is shared: one visitor\'s cached answer serves everyone', () => {
  const t = setup();
  try {
    const a = t.ws.create();
    const b = t.ws.create();
    a.db.prepare("INSERT INTO ai_cache (key, model, response) VALUES ('facts', 'm', '{\"ok\":1}')").run();
    assert.equal(b.db.prepare("SELECT response FROM ai_cache WHERE key = 'facts'").get().response, '{"ok":1}');
    assert.equal(t.shared.prepare("SELECT COUNT(*) AS n FROM ai_cache").get().n, 1);
  } finally {
    t.done();
  }
});

test('PayPal history is copied in, with labels, without overriding the visitor\'s own', () => {
  const t = setup();
  try {
    addPayPal(t.shared, 'paypal-1');
    const a = t.ws.create();
    assert.equal(a.db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'paypal'").get().n, 1);
    t.shared.prepare("UPDATE transactions SET category = 'fuel' WHERE id = 'paypal-1'").run();
    addPayPal(t.shared, 'paypal-2', 'food');
    copyPayPal(a.db);
    assert.deepEqual(a.db.prepare("SELECT id, category FROM transactions WHERE source = 'paypal' ORDER BY id").all().map((r) => [r.id, r.category]), [['paypal-1', 'fuel'], ['paypal-2', 'food']]);
    a.db.prepare("UPDATE transactions SET category = 'shopping' WHERE id = 'paypal-2'").run();
    copyPayPal(a.db);
    assert.equal(a.db.prepare("SELECT category FROM transactions WHERE id = 'paypal-2'").get().category, 'shopping');
  } finally {
    t.done();
  }
});

test('reset removes the file; idle and excess workspaces are cleaned up', () => {
  const t = setup({ maxWorkspaces: 2, idleDays: 14 });
  try {
    const a = t.ws.create();
    const file = path.join(t.dir, 'workspaces', `${a.id}.db`);
    assert.ok(existsSync(file));
    t.ws.remove(a.id);
    assert.ok(!existsSync(file));
    assert.equal(t.ws.get(a.id), null);

    const b = t.ws.create();
    t.tick(120_000);
    const c = t.ws.create();
    t.tick(120_000);
    t.ws.get(b.id); // b is now more recent than c
    t.tick(120_000);
    t.ws.create(); // a third: the least recently seen (c) goes
    assert.equal(t.ws.get(c.id), null);
    assert.ok(t.ws.get(b.id));
    assert.equal(t.ws.count(), 2);

    assert.equal(t.ws.active(1).length, 2);
    t.tick(15 * 86_400_000);
    assert.equal(t.ws.active(1).length, 0);
    assert.equal(t.ws.cleanup(), 2);
    assert.equal(t.ws.count(), 0);
  } finally {
    t.done();
  }
});

test('Plaid webhooks find the workspace that connected the item', () => {
  const t = setup();
  try {
    const a = t.ws.create();
    t.ws.setItemOwner('item-1', a.id);
    assert.equal(t.ws.ownerOfItem('item-1'), a.id);
    assert.equal(t.ws.ownerOfItem('item-x'), null);
    t.ws.remove(a.id);
    assert.equal(t.ws.ownerOfItem('item-1'), null);
  } finally {
    t.done();
  }
});
