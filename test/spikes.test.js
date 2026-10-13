import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';

let seq = 0;
function dbWith(txns) {
  const db = openDb(':memory:');
  const insert = db.prepare(`
    INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category, seed_recurring)
    VALUES (?, ?, ?, 'Test', 'seed', ?, ?)
  `);
  for (const [date, cents, cat, recurring = 0] of txns) {
    insert.run(`t${++seq}`, `${date}T12:00:00Z`, cents, cat, recurring);
  }
  return db;
}

// Three baseline months of $160 fuel (4 x $40) and $50 in subscriptions.
function baseline() {
  const txns = [];
  for (const m of ['2026-07', '2026-08', '2026-09']) {
    for (const d of ['03', '10', '17', '24']) txns.push([`${m}-${d}`, 4000, 'fuel']);
    txns.push([`${m}-05`, 5000, 'entertainment', 1]);
  }
  return txns;
}

const find = (report, cat) => report.categories.find((c) => c.category === cat);

test('flags a fuel spike before the partial total passes the usual month', () => {
  // $150 by Oct 10 is below the usual $160, but normal spending for the remaining
  // 21 days adds another $108.39, ending the month 61% above usual.
  const db = dbWith([...baseline(), ['2026-10-02', 5000, 'fuel'], ['2026-10-05', 5000, 'fuel'], ['2026-10-09', 5000, 'fuel']]);
  const r = detectSpikes(db, { asOf: '2026-10-10' });
  const fuel = find(r, 'fuel');
  assert.deepEqual(r.baselineMonths, ['2026-07', '2026-08', '2026-09']);
  assert.equal(fuel.baselineAvgCents, 16000);
  assert.equal(fuel.currentCents, 15000);
  assert.equal(fuel.projectedCents, 25839); // 15000 + round(16000 * 21 / 31)
  assert.equal(fuel.increasePct, 61.5);
  assert.equal(fuel.alreadyOver, false);
  assert.equal(fuel.isSpike, true);
  assert.deepEqual(r.spikes.map((s) => s.category), ['fuel']);
});

test('an early-month cluster of normal purchases is not a spike', () => {
  // Usual $310/month spread over the month; this month 8 x $20 land in the first 8 days.
  // Scaling $160 by 31/8 would project $620; spending normally from here ends near $320.
  const txns = [];
  for (const m of ['2026-07', '2026-08', '2026-09']) {
    for (let d = 1; d <= 31; d += 2) txns.push([`${m}-${String(d).padStart(2, '0')}`, 2000, 'food']);
  }
  for (let d = 1; d <= 8; d++) txns.push([`2026-10-0${d}`, 2000, 'food']);
  const food = find(detectSpikes(dbWith(txns), { asOf: '2026-10-08' }), 'food');
  assert.equal(food.isSpike, false);
});

test('recurring charges are not scaled by pace', () => {
  // A $50 subscription charged on day 5 must not project to $310 for the month.
  const db = dbWith([...baseline(), ['2026-10-05', 5000, 'entertainment', 1]]);
  const ent = find(detectSpikes(db, { asOf: '2026-10-10' }), 'entertainment');
  assert.equal(ent.projectedCents, 5000);
  assert.equal(ent.isSpike, false);
});

test('a recurring charge not yet billed this month still counts toward the projection', () => {
  const db = dbWith(baseline());
  const ent = find(detectSpikes(db, { asOf: '2026-10-03' }), 'entertainment');
  assert.equal(ent.currentCents, 0);
  assert.equal(ent.projectedCents, 5000);
});

test('early in the month, one large purchase alone is not a spike', () => {
  // Day 3: one $60 fill-up + usual $144.52 for the rest of the month = $204.52 (+28%).
  const early = dbWith([...baseline(), ['2026-10-02', 6000, 'fuel']]);
  assert.equal(find(detectSpikes(early, { asOf: '2026-10-03' }), 'fuel').isSpike, false);

  const over = dbWith([...baseline(), ['2026-10-01', 12000, 'fuel'], ['2026-10-02', 12000, 'fuel']]);
  const fuel = find(detectSpikes(over, { asOf: '2026-10-03' }), 'fuel');
  assert.equal(fuel.alreadyOver, true);
  assert.equal(fuel.isSpike, true);
});

test('ignores small absolute increases even when the percentage is high', () => {
  const txns = [];
  for (const m of ['2026-07', '2026-08', '2026-09']) txns.push([`${m}-10`, 1000, 'shopping']);
  txns.push(['2026-10-10', 1000, 'shopping'], ['2026-10-12', 500, 'shopping']); // $10 usual, heading for ~$20
  const shop = find(detectSpikes(dbWith(txns), { asOf: '2026-10-15' }), 'shopping');
  assert.ok(shop.increasePct > 30);
  assert.equal(shop.isSpike, false);
});

test('baseline starts at the first month with data, not at empty months', () => {
  const db = dbWith(baseline()); // history begins in July
  const r = detectSpikes(db, { asOf: '2026-10-15', lookbackMonths: 6 });
  assert.deepEqual(r.baselineMonths, ['2026-07', '2026-08', '2026-09']);
  assert.equal(find(r, 'fuel').baselineAvgCents, 16000);
});

test('a month with no spending in a category counts as $0 in the baseline', () => {
  const txns = [['2026-07-10', 9000, 'shopping'], ['2026-09-10', 9000, 'shopping'], ['2026-08-01', 100, 'fuel']];
  const shop = find(detectSpikes(dbWith(txns), { asOf: '2026-10-15' }), 'shopping');
  assert.equal(shop.baselineAvgCents, 6000); // (9000 + 0 + 9000) / 3
});

test('transactions after asOf are ignored', () => {
  const db = dbWith([...baseline(), ['2026-10-20', 50000, 'fuel']]);
  assert.equal(find(detectSpikes(db, { asOf: '2026-10-10' }), 'fuel').currentCents, 0);
});

test('LLM category overrides the seed label', () => {
  const db = dbWith([...baseline(), ['2026-10-05', 30000, 'shopping']]);
  db.prepare("UPDATE transactions SET category = 'fuel' WHERE occurred_at LIKE '2026-10-05%'").run();
  const r = detectSpikes(db, { asOf: '2026-10-10' });
  assert.equal(find(r, 'fuel').currentCents, 30000);
  assert.equal(find(r, 'shopping'), undefined);
});

test('rejects malformed dates', () => {
  const db = dbWith([]);
  assert.throws(() => detectSpikes(db, { asOf: '2026-13-01' }));
  assert.throws(() => detectSpikes(db, { asOf: '10/13/2026' }));
});
