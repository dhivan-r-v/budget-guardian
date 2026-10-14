import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';
import { suggestSavings, suggestSavingsForSpikes, setFlexible, isFlexible } from '../src/savings.js';

let seq = 0;
function dbWith(txns, flexible = ['fuel', 'entertainment', 'shopping']) {
  const db = openDb(':memory:');
  const insert = db.prepare(`
    INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category, seed_recurring)
    VALUES (?, ?, ?, ?, 'seed', ?, ?)
  `);
  for (const [date, cents, cat, merchant = 'Shop', recurring = 0] of txns) {
    insert.run(`t${++seq}`, `${date}T12:00:00Z`, cents, merchant, cat, recurring);
  }
  for (const c of flexible) setFlexible(db, c, true);
  return db;
}

const BASE_MONTHS = ['2026-07', '2026-08', '2026-09'];
const fuelBaseline = () =>
  BASE_MONTHS.flatMap((m) => ['03', '10', '17', '24'].map((d) => [`${m}-${d}`, 4000, 'fuel', 'Shell']));

function savingsFor(txns, category, { asOf = '2026-10-13', flexible, overrides } = {}) {
  const db = dbWith(txns, flexible);
  const report = detectSpikes(db, { asOf });
  const entry = report.categories.find((c) => c.category === category);
  return suggestSavings(db, report, entry, overrides);
}

// Fuel this month: $260 over 13 days = $20/day.
const fuelSpike = () => [
  ...fuelBaseline(),
  ...['01', '03', '06', '09', '12'].map((d) => [`2026-10-${d}`, 5200, 'fuel', 'Shell']),
];

test('fuel: public transport days save fuel minus fare, with CO2', () => {
  const s = savingsFor(fuelSpike(), 'fuel');
  assert.equal(s.flexible, true);
  assert.equal(s.assumptions.dailyFuelCents, 2000);
  assert.equal(s.assumptions.remainingDays, 18);
  assert.deepEqual(
    s.options.map((o) => [o.transitDays, o.fuelAvoidedCents, o.transitCostCents, o.savingsCents]),
    [
      [2, 4000, 1100, 2900],
      [3, 6000, 1650, 4350],
    ],
  );
  // $60 of fuel at $3.50/gal = 17.14 gal x 8.887 kg = 152.3 kg
  assert.equal(s.options[1].gallonsAvoided, 17.1);
  assert.equal(s.options[1].co2AvoidedKg, 152.3);
});

test('fuel: options never exceed the days left in the month', () => {
  const s = savingsFor(fuelSpike(), 'fuel', { asOf: '2026-10-29', overrides: { transitDayOptions: [2, 3] } });
  assert.deepEqual(s.options.map((o) => o.transitDays), [2]);
});

test('fuel: no option when the fare costs more than the fuel it replaces', () => {
  const s = savingsFor(fuelSpike(), 'fuel', { overrides: { transitFarePerDayCents: 2500 } });
  assert.deepEqual(s.options, []);
});

test('entertainment: only subscriptions not billed yet save money this month', () => {
  const subs = [
    ['Netflix', '03', 1549],
    ['Spotify', '08', 1199],
    ['Disney+', '19', 999],
    ['YouTube Premium', '24', 1399],
  ];
  const txns = BASE_MONTHS.flatMap((m) => subs.map(([name, d, c]) => [`${m}-${d}`, c, 'entertainment', name, 1]));
  txns.push(['2026-10-03', 1549, 'entertainment', 'Netflix', 1], ['2026-10-08', 1199, 'entertainment', 'Spotify', 1]);

  const s = savingsFor(txns, 'entertainment');
  const opt = s.options[0];
  assert.equal(opt.type, 'skip_subscriptions');
  assert.deepEqual(
    opt.subscriptions.map((x) => [x.merchant, x.billingDay, x.chargedThisMonth, x.savingsThisMonthCents]),
    [
      ['YouTube Premium', 24, false, 1399],
      ['Disney+', 19, false, 999],
      ['Netflix', 3, true, 0],
      ['Spotify', 8, true, 0],
    ],
  );
  assert.equal(opt.savingsCents, 2398);
  assert.equal(opt.monthlyCents, 5146);
});

test('entertainment: a cancelled subscription (not billed last month) is not suggested', () => {
  const txns = [
    ['2026-07-05', 999, 'entertainment', 'Hulu', 1], // stopped after July
    ...BASE_MONTHS.map((m) => [`${m}-20`, 1549, 'entertainment', 'Netflix', 1]),
  ];
  const s = savingsFor(txns, 'entertainment');
  assert.deepEqual(s.options[0].subscriptions.map((x) => x.merchant), ['Netflix']);
});

test('other categories: cut back one-off spending for the rest of the month', () => {
  const txns = BASE_MONTHS.map((m) => [`${m}-10`, 31000, 'shopping']); // $310 usual
  const s = savingsFor(txns, 'shopping');
  // Usual for the remaining 18 of 31 days: $180. 25% = $45, 50% = $90.
  assert.deepEqual(s.options.map((o) => [o.percent, o.savingsCents]), [[25, 4500], [50, 9000]]);
});

test('no suggestions for a category the user has not marked flexible', () => {
  const s = savingsFor(fuelSpike(), 'fuel', { flexible: [] });
  assert.equal(s.flexible, false);
  assert.deepEqual(s.options, []);
});

test('setFlexible can turn a category on and off', () => {
  const db = dbWith([], []);
  setFlexible(db, 'fuel', true);
  assert.equal(isFlexible(db, 'fuel'), true);
  setFlexible(db, 'fuel', false);
  assert.equal(isFlexible(db, 'fuel'), false);
});

test('suggestSavingsForSpikes attaches savings to every spike', () => {
  const db = dbWith(fuelSpike());
  const report = suggestSavingsForSpikes(db, detectSpikes(db, { asOf: '2026-10-13' }));
  assert.deepEqual(report.spikes.map((s) => [s.category, s.savings.options.length]), [['fuel', 2]]);
});

test('fuel: early in the month the daily rate is averaged over at least 7 days', () => {
  // $104 in 2 fill-ups by day 2: $104 / 7 days, not $52/day.
  const txns = [...fuelBaseline(), ['2026-10-01', 5200, 'fuel', 'Shell'], ['2026-10-02', 5200, 'fuel', 'Shell']];
  const s = savingsFor(txns, 'fuel', { asOf: '2026-10-02' });
  assert.equal(s.assumptions.dailyFuelCents, 1486);
});
