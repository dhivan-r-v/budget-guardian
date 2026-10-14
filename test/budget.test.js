import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';
import { getBudget, setBudget, budgetStatus } from '../src/budget.js';

let seq = 0;
// Usual month: fuel $160 (4 x $40) + a $50 subscription on the 20th = $210.
function dbWith(current) {
  const db = openDb(':memory:');
  const insert = db.prepare(`
    INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category, seed_recurring)
    VALUES (?, ?, ?, 'X', 'seed', ?, ?)
  `);
  for (const m of ['2026-07', '2026-08', '2026-09']) {
    for (const d of ['03', '10', '17', '24']) insert.run(`t${++seq}`, `${m}-${d}T12:00:00Z`, 4000, 'fuel', 0);
    insert.run(`t${++seq}`, `${m}-20T12:00:00Z`, 5000, 'entertainment', 1);
  }
  for (const [date, cents, cat, rec = 0] of current) insert.run(`t${++seq}`, `${date}T12:00:00Z`, cents, cat, rec);
  return db;
}
const status = (db, asOf = '2026-10-10') => budgetStatus(db, detectSpikes(db, { asOf }));

test('without a budget, spending is reported but nothing is judged', () => {
  const s = status(dbWith([['2026-10-02', 4000, 'fuel']]));
  assert.equal(s.set, false);
  assert.equal(s.spentCents, 4000);
  assert.equal(s.safeToSpendCents, undefined);
});

test('safe to spend excludes recurring charges still to come, and splits over the days left', () => {
  const db = dbWith([['2026-10-02', 4000, 'fuel']]);
  setBudget(db, 30000);
  const s = status(db);
  assert.equal(s.spentCents, 4000);
  assert.equal(s.upcomingRecurringCents, 5000); // the subscription bills on the 20th
  assert.equal(s.safeToSpendCents, 21000); // 300 - 40 - 50
  assert.equal(s.daysLeft, 21);
  assert.equal(s.perDayCents, 1000);
  assert.equal(s.overBudget, false);
});

test('a recurring charge already billed is no longer upcoming', () => {
  const db = dbWith([['2026-10-02', 4000, 'fuel'], ['2026-10-08', 5000, 'entertainment', 1]]);
  setBudget(db, 30000);
  const s = status(db);
  assert.equal(s.upcomingRecurringCents, 0);
  assert.equal(s.safeToSpendCents, 21000);
});

test('when only the spike pushes the month over budget, it says so', () => {
  // Fuel spike: $250 by day 10 projects $250 + 160 x 21/31 = $358.39.
  const db = dbWith(['02', '04', '06', '08', '10'].map((d) => [`2026-10-${d}`, 5000, 'fuel']));
  setBudget(db, 45000);
  const s = status(db);
  assert.equal(s.spikes[0].category, 'fuel');
  assert.equal(s.projectedCents, 35839 + 5000);
  assert.equal(s.overBudget, false); // $408.39 < $450

  setBudget(db, 38000);
  const over = status(db);
  assert.equal(over.overBudget, true);
  assert.equal(over.projectedVsBudgetCents, 2839);
  assert.equal(over.spikesCauseOverspend, true); // the spike added $198.39, more than the $28.39 over
});

test('safe to spend never goes negative per day, even when already over', () => {
  const db = dbWith([['2026-10-02', 40000, 'fuel']]);
  setBudget(db, 30000);
  const s = status(db);
  assert.ok(s.safeToSpendCents < 0);
  assert.equal(s.perDayCents, 0);
});

test('the budget must be a positive whole number of cents', () => {
  const db = dbWith([]);
  assert.throws(() => setBudget(db, 0), RangeError);
  assert.throws(() => setBudget(db, 12.5), RangeError);
  setBudget(db, 110000);
  assert.equal(getBudget(db), 110000);
});
