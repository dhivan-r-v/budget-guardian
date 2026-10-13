import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';
import { setFlexible } from '../src/savings.js';
import { habitInsights } from '../src/habits.js';

let seq = 0;
function dbWith(txns, flexible = ['food', 'fuel', 'entertainment']) {
  const db = openDb(':memory:');
  const insert = db.prepare(`
    INSERT INTO transactions (id, occurred_at, amount_cents, merchant, description, source, seed_category, seed_recurring)
    VALUES (?, ?, ?, ?, ?, 'seed', ?, ?)
  `);
  for (const [date, cents, merchant, description, cat, recurring = 0] of txns) {
    insert.run(`t${++seq}`, `${date}T12:00:00Z`, cents, merchant, description, cat, recurring);
  }
  for (const c of flexible) setFlexible(db, c, true);
  return db;
}

const MONTHS = ['2026-07', '2026-08', '2026-09'];
const day = (d) => String(d).padStart(2, '0');

// Coffee 6x/month at $5 split across two merchants; groceries 4x/month at $60.
function history() {
  const txns = [];
  for (const m of MONTHS) {
    for (let d = 1; d <= 6; d++) txns.push([`${m}-${day(d * 4)}`, 500, d % 2 ? 'Starbucks' : 'Dunkin', 'Coffee', 'food']);
    for (const d of [2, 9, 16, 23]) txns.push([`${m}-${day(d)}`, 6000, 'Kroger', 'Groceries', 'food']);
  }
  txns.push(['2026-10-02', 500, 'Starbucks', 'Coffee', 'food'], ['2026-10-05', 600, 'Dunkin', 'Coffee', 'food']);
  return txns;
}

const habitsFor = (db, asOf = '2026-10-13') => habitInsights(db, detectSpikes(db, { asOf }));

test('a small, frequent purchase across merchants is one habit with yearly cost and savings', () => {
  const [coffee, ...rest] = habitsFor(dbWith(history()));
  assert.deepEqual(rest, []); // groceries are frequent but not small
  assert.equal(coffee.id, 'habit:food:Coffee');
  assert.deepEqual(coffee.merchants, ['Dunkin', 'Starbucks']);
  assert.equal(coffee.perMonth, 6);
  assert.equal(coffee.averageCents, 500);
  assert.equal(coffee.monthlyCents, 3000);
  assert.equal(coffee.yearlyCents, 36000);
  assert.deepEqual(coffee.thisMonth, { count: 2, cents: 1100 });
  assert.deepEqual(coffee.cutBack, { percent: 50, perMonth: 3, savingsPerMonthCents: 1500, savingsPerYearCents: 18000 });
});

test('purchases that are not frequent enough are not habits', () => {
  const txns = MONTHS.flatMap((m) => [1, 10, 20].map((d) => [`${m}-${day(d)}`, 500, 'Starbucks', 'Coffee', 'food']));
  assert.deepEqual(habitsFor(dbWith(txns)), []); // 3 a month
});

test('a burst in a single month is not a habit', () => {
  const txns = Array.from({ length: 15 }, (_, i) => ['2026-09-' + day(i + 1), 500, 'Starbucks', 'Coffee', 'food']);
  txns.push(['2026-07-01', 100, 'Kroger', 'Groceries', 'food']); // baseline starts in July
  assert.deepEqual(habitsFor(dbWith(txns)), []); // 5 a month on average, but only one month
});

test('subscriptions and bills are not habits', () => {
  const txns = MONTHS.flatMap((m) => [1, 8, 15, 22, 29].map((d) => [`${m}-${day(d)}`, 999, 'Spotify', 'Premium', 'entertainment', 1]));
  assert.deepEqual(habitsFor(dbWith(txns)), []);
});

test('only categories the user marked flexible are shown', () => {
  assert.deepEqual(habitsFor(dbWith(history(), [])), []);
});

test('without a description, purchases are grouped by merchant', () => {
  const txns = MONTHS.flatMap((m) => [1, 7, 14, 21].map((d) => [`${m}-${day(d)}`, 800, 'Uber Eats', null, 'food']));
  const [habit] = habitsFor(dbWith(txns));
  assert.equal(habit.label, 'Uber Eats');
  assert.equal(habit.perMonth, 4);
});
