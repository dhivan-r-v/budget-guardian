import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';
import { monthlyHistory } from '../src/history.js';

test('monthly totals per category, with the current month split into so far + projected rest', () => {
  const db = openDb(':memory:');
  const insert = db.prepare(`
    INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category, seed_recurring)
    VALUES (?, ?, ?, 'Shell', 'seed', 'fuel', 0)
  `);
  let n = 0;
  for (const [m, cents] of [['2026-07', 15000], ['2026-08', 17000], ['2026-09', 16000]]) insert.run(`t${++n}`, `${m}-10T12:00:00Z`, cents);
  insert.run(`t${++n}`, '2026-10-05T12:00:00Z', 20000);
  insert.run(`t${++n}`, '2026-10-20T12:00:00Z', 99999); // after asOf: excluded

  const report = detectSpikes(db, { asOf: '2026-10-13' });
  const h = monthlyHistory(db, report);
  assert.deepEqual(h.months, ['2026-07', '2026-08', '2026-09', '2026-10']);
  const [fuel] = h.categories;
  assert.equal(fuel.usualCents, 16000);
  assert.deepEqual(fuel.months.map((m) => m.cents), [15000, 17000, 16000, 20000]);
  const now = fuel.months.at(-1);
  assert.equal(now.current, true);
  assert.equal(now.cents + now.projectedRestCents, fuel.projectedCents);
});
