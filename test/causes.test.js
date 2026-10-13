import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';
import { explainSpike, explainSpikes } from '../src/causes.js';

let seq = 0;
function dbWith(txns) {
  const db = openDb(':memory:');
  const insert = db.prepare(`
    INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category, seed_recurring)
    VALUES (?, ?, ?, ?, 'seed', ?, ?)
  `);
  for (const [date, cents, cat, merchant = 'Shop', recurring = 0] of txns) {
    insert.run(`t${++seq}`, `${date}T12:00:00Z`, cents, merchant, cat, recurring);
  }
  return db;
}

const BASE_MONTHS = ['2026-07', '2026-08', '2026-09'];

// Usual fuel: 4 fill-ups of $40 a month.
function fuelBaseline() {
  return BASE_MONTHS.flatMap((m) => ['03', '10', '17', '24'].map((d) => [`${m}-${d}`, 4000, 'fuel', 'Shell']));
}

function explain(txns, category, asOf = '2026-10-13') {
  const db = dbWith(txns);
  const report = detectSpikes(db, { asOf });
  const entry = report.categories.find((c) => c.category === category);
  const cause = explainSpike(db, report, entry);
  // The parts must always add up exactly to the detector's increase.
  assert.equal(cause.recurring.excessCents + cause.oneOff.excessCents, entry.increaseCents);
  assert.equal(cause.oneOff.moreOftenCents + cause.oneOff.higherPricesCents, cause.oneOff.excessCents);
  return { entry, cause };
}

test('more fill-ups than usual: cause is "more often"', () => {
  // 5 x $40 by day 13, where ~1.7 fill-ups would be usual by now.
  const days = ['01', '04', '07', '10', '12'];
  const { cause } = explain([...fuelBaseline(), ...days.map((d) => [`2026-10-${d}`, 4000, 'fuel', 'Shell'])], 'fuel');
  assert.equal(cause.primaryCause, 'more_often');
  assert.equal(cause.oneOff.count, 5);
  assert.equal(cause.oneOff.expectedCount, 1.7); // 4 * 13 / 31
  assert.equal(cause.oneOff.usualAmountCents, 4000);
  assert.equal(cause.oneOff.averageAmountCents, 4000);
  assert.equal(cause.oneOff.moreOftenCents, 13290); // (5 - 1.677) x $40
  assert.equal(cause.oneOff.higherPricesCents, 0);
  assert.equal(cause.transactions.length, 5);
});

test('usual number of fill-ups but pricier: cause is "higher prices"', () => {
  const { cause } = explain([...fuelBaseline(), ['2026-10-02', 8000, 'fuel'], ['2026-10-09', 8000, 'fuel']], 'fuel');
  assert.equal(cause.primaryCause, 'higher_prices');
  assert.equal(cause.oneOff.averageAmountCents, 8000);
  assert.ok(cause.oneOff.higherPricesCents > cause.oneOff.moreOftenCents);
});

test('one big purchase that explains most of the increase is called out', () => {
  // Usual: two $20 outings a month. This month: one $150 concert ticket.
  const base = BASE_MONTHS.flatMap((m) => [[`${m}-06`, 2000, 'entertainment', 'AMC'], [`${m}-20`, 2000, 'entertainment', 'AMC']]);
  const { cause } = explain([...base, ['2026-10-08', 15000, 'entertainment', 'Ticketmaster']], 'entertainment');
  assert.equal(cause.primaryCause, 'large_purchase');
  assert.deepEqual(
    cause.largePurchases.map((t) => [t.merchant, t.amountCents, t.date]),
    [['Ticketmaster', 15000, '2026-10-08']],
  );
});

test('a new subscription is detected by merchant', () => {
  const base = BASE_MONTHS.map((m) => [`${m}-03`, 1549, 'entertainment', 'Netflix', 1]);
  const { cause } = explain(
    [...base, ['2026-10-03', 1549, 'entertainment', 'Netflix', 1], ['2026-10-06', 1699, 'entertainment', 'Max', 1]],
    'entertainment',
  );
  assert.equal(cause.primaryCause, 'new_subscription');
  assert.equal(cause.recurring.excessCents, 1699);
  assert.deepEqual(cause.recurring.newSubscriptions.map((t) => t.merchant), ['Max']);
  assert.deepEqual(cause.recurring.priceIncreases, []);
});

test('a subscription price increase is detected', () => {
  const base = BASE_MONTHS.map((m) => [`${m}-03`, 1549, 'entertainment', 'Netflix', 1]);
  const { cause } = explain([...base, ['2026-10-03', 1799, 'entertainment', 'Netflix', 1]], 'entertainment');
  assert.equal(cause.primaryCause, 'subscription_price_increase');
  assert.equal(cause.recurring.excessCents, 250);
  assert.deepEqual(
    cause.recurring.priceIncreases.map((t) => [t.merchant, t.amountCents, t.usualAmountCents]),
    [['Netflix', 1799, 1549]],
  );
});

test('only transactions in the category, month and up to asOf are included', () => {
  const { cause } = explain(
    [
      ...fuelBaseline(),
      ['2026-10-05', 4000, 'fuel'],
      ['2026-10-05', 9999, 'food'],
      ['2026-09-30', 4000, 'fuel'], // previous month
      ['2026-10-20', 4000, 'fuel'], // after asOf
    ],
    'fuel',
  );
  assert.deepEqual(cause.transactions.map((t) => t.date), ['2026-10-05']);
});

test('explainSpikes attaches a cause to every spike', () => {
  const days = ['01', '04', '07', '10', '12'];
  const db = dbWith([...fuelBaseline(), ...days.map((d) => [`2026-10-${d}`, 4000, 'fuel', 'Shell'])]);
  const report = explainSpikes(db, detectSpikes(db, { asOf: '2026-10-13' }));
  assert.deepEqual(report.spikes.map((s) => [s.category, s.cause.primaryCause]), [['fuel', 'more_often']]);
});
