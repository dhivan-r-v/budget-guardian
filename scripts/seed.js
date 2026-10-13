// Seeds realistic spending history, since PayPal sandbox accounts start empty.
//
// Usage: node scripts/seed.js [--months 5] [--end YYYY-MM-DD] [--seed 42]
//
// Generates `months` calendar months ending with the month of `end` (default: today).
// The last month only contains transactions up to `end`, like a real in-progress month.
// Baseline: ~4 fuel fill-ups/month. Latest month: a fill-up every 2-3 days (the fuel spike).
// Entertainment has 4 recurring subscriptions on fixed days plus occasional one-offs.
// Re-running replaces all previously seeded rows; PayPal rows are never touched.

import { parseArgs } from 'node:util';
import { openDb, DB_PATH } from '../src/db.js';

const { values: args } = parseArgs({
  options: {
    months: { type: 'string', default: '5' },
    end: { type: 'string', default: new Date().toISOString().slice(0, 10) },
    seed: { type: 'string', default: '42' },
  },
});

const MONTHS = Number(args.months);
const END = args.end;
if (!Number.isInteger(MONTHS) || MONTHS < 2) throw new Error('--months must be an integer >= 2');
if (!/^\d{4}-\d{2}-\d{2}$/.test(END)) throw new Error('--end must be YYYY-MM-DD');

// Deterministic PRNG (mulberry32) so the demo data is identical on every run.
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(args.seed));
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (list) => list[int(0, list.length - 1)];

const SUBSCRIPTIONS = [
  { day: 3, merchant: 'Netflix', description: 'Netflix Standard plan', cents: 1549 },
  { day: 8, merchant: 'Spotify', description: 'Spotify Premium Individual', cents: 1199 },
  { day: 19, merchant: 'Disney+', description: 'Disney+ Basic', cents: 999 },
  { day: 24, merchant: 'YouTube Premium', description: 'YouTube Premium membership', cents: 1399 },
];
const BILLS = [
  { day: 5, merchant: 'Planet Fitness', description: 'Monthly membership', cents: 1500 },
  { day: 12, merchant: 'Mint Mobile', description: 'Unlimited plan', cents: 3000 },
];
const FUEL_STATIONS = ['Shell', 'Chevron', 'ExxonMobil', 'BP', 'Costco Gas'];
const GROCERY = ["Trader Joe's", 'Walmart', 'Kroger', 'Aldi'];
const DINING = ['Chipotle', 'DoorDash', 'Uber Eats', 'Panera Bread', 'Taco Bell', "Domino's"];
const COFFEE = ['Starbucks', 'Dunkin'];
const SHOPPING = [
  ['Amazon', 'Amazon.com order'],
  ['Target', 'Target purchase'],
  ['Best Buy', 'Electronics accessory'],
  ['H&M', 'Clothing'],
  ['Etsy', 'Etsy order'],
];
const ENTERTAINMENT_ONE_OFF = [
  ['AMC Theatres', 'Movie tickets', 1400, 2800],
  ['Steam', 'Game purchase', 999, 3999],
  ['Ticketmaster', 'Concert ticket', 4500, 8500],
  ['Dave & Buster\'s', 'Arcade night', 2000, 4000],
];

const [endY, endM, endD] = END.split('-').map(Number);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');

function generateMonth(y, m, lastDay, isSpikeMonth) {
  const txns = [];
  const monthDays = daysInMonth(y, m);
  const add = (day, merchant, description, cents, category, recurring = false) => {
    if (day < 1 || day > lastDay) return;
    txns.push({
      occurred_at: `${y}-${pad(m)}-${pad(day)}T${pad(int(7, 21))}:${pad(int(0, 59))}:00Z`,
      merchant,
      description,
      amount_cents: cents,
      seed_category: category,
      seed_recurring: recurring ? 1 : 0,
    });
  };

  for (const s of SUBSCRIPTIONS) add(s.day, s.merchant, s.description, s.cents, 'entertainment', true);
  for (const b of BILLS) add(b.day, b.merchant, b.description, b.cents, 'bills', true);

  // Fuel: weekly fill-ups normally; every 2-3 days with pricier fills in the spike month.
  if (isSpikeMonth) {
    for (let day = int(1, 2); day <= lastDay; day += int(2, 3)) {
      add(day, pick(FUEL_STATIONS), 'Fuel purchase', int(4200, 5600), 'fuel');
    }
  } else {
    for (const start of [2, 9, 17, 25]) {
      add(start + int(0, 3), pick(FUEL_STATIONS), 'Fuel purchase', int(3600, 4800), 'fuel');
    }
  }

  for (const start of [1, 8, 15, 22]) {
    add(start + int(0, 4), pick(GROCERY), 'Groceries', int(3500, 8500), 'food');
  }
  for (let i = int(7, 10); i > 0; i--) add(int(1, monthDays), pick(DINING), 'Food order', int(1100, 3400), 'food');
  for (let i = int(10, 14); i > 0; i--) add(int(1, monthDays), pick(COFFEE), 'Coffee', int(450, 695), 'food');

  for (let i = int(2, 4); i > 0; i--) {
    const [merchant, description] = pick(SHOPPING);
    add(int(1, monthDays), merchant, description, int(1500, 7500), 'shopping');
  }
  for (let i = int(1, 2); i > 0; i--) {
    const [merchant, description, min, max] = pick(ENTERTAINMENT_ONE_OFF);
    add(int(1, monthDays), merchant, description, int(min, max), 'entertainment');
  }

  txns.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  return txns.map((t, i) => ({ id: `seed-${y}${pad(m)}-${String(i + 1).padStart(3, '0')}`, ...t }));
}

const all = [];
for (let offset = MONTHS - 1; offset >= 0; offset--) {
  const d = new Date(Date.UTC(endY, endM - 1 - offset, 1));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const isLatest = offset === 0;
  all.push(...generateMonth(y, m, isLatest ? endD : daysInMonth(y, m), isLatest));
}

const db = openDb();
const insert = db.prepare(`
  INSERT INTO transactions
    (id, occurred_at, amount_cents, currency, merchant, description, source, seed_category, seed_recurring)
  VALUES (?, ?, ?, 'USD', ?, ?, 'seed', ?, ?)
`);
db.exec('BEGIN');
try {
  db.prepare("DELETE FROM transactions WHERE source = 'seed'").run();
  for (const t of all) {
    insert.run(t.id, t.occurred_at, t.amount_cents, t.merchant, t.description, t.seed_category, t.seed_recurring);
  }
  // The demo user's choice of flexible categories; never overrides a choice already made.
  const pref = db.prepare('INSERT OR IGNORE INTO category_prefs (category, flexible) VALUES (?, 1)');
  for (const category of ['fuel', 'entertainment', 'food']) pref.run(category);
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

// Summary: monthly totals per category (ground-truth labels), in dollars.
const rows = db
  .prepare(`
    SELECT substr(occurred_at, 1, 7) AS month, seed_category AS category, SUM(amount_cents) AS cents
    FROM transactions WHERE source = 'seed'
    GROUP BY month, seed_category ORDER BY month
  `)
  .all();
const summary = {};
for (const r of rows) (summary[r.month] ??= {})[r.category] = (r.cents / 100).toFixed(2);
console.log(`Seeded ${all.length} transactions into ${DB_PATH} (latest month runs to ${END}).`);
console.table(summary);
db.close();
