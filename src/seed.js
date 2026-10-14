// Realistic demo spending history (PayPal sandbox accounts start with none).
//
// `months` calendar months ending with the month of `end`. The last month only contains
// transactions up to `end`, like a real in-progress month, and holds the fuel spike: fill-ups
// every ~2.6 days at higher prices (at least 2, so the spike shows from day 2), against ~4 a
// month before. Entertainment has 4 recurring subscriptions plus occasional one-offs.
// Seeding replaces seed rows only; PayPal rows and approvals are never touched.

// Deterministic PRNG (mulberry32) so the demo data is identical for the same inputs.
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  ["Dave & Buster's", 'Arcade night', 2000, 4000],
];
// The demo user's choice of flexible categories.
export const DEMO_FLEXIBLE = ['fuel', 'entertainment', 'food'];

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');

export function generateDemo({ months = 5, end, seed = 42 }) {
  if (!Number.isInteger(months) || months < 2) throw new Error('months must be an integer >= 2');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end ?? '')) throw new Error('end must be YYYY-MM-DD');
  const rand = mulberry32(seed);
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const pick = (list) => list[int(0, list.length - 1)];
  const [endY, endM, endD] = end.split('-').map(Number);

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

    if (isSpikeMonth) {
      const fills = Math.max(2, Math.ceil(lastDay / 2.6));
      for (let i = 0; i < fills; i++) {
        add(1 + Math.floor((i * lastDay) / fills), pick(FUEL_STATIONS), 'Fuel purchase', int(4200, 5600), 'fuel');
      }
    } else {
      for (const start of [2, 9, 17, 25]) add(start + int(0, 3), pick(FUEL_STATIONS), 'Fuel purchase', int(3600, 4800), 'fuel');
    }

    for (const start of [1, 8, 15, 22]) add(start + int(0, 4), pick(GROCERY), 'Groceries', int(3500, 8500), 'food');
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
  for (let offset = months - 1; offset >= 0; offset--) {
    const d = new Date(Date.UTC(endY, endM - 1 - offset, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    all.push(...generateMonth(y, m, offset === 0 ? endD : daysInMonth(y, m), offset === 0));
  }
  return all;
}

// Replaces seed rows with fresh demo history; returns the number inserted.
export function seedDemo(db, opts) {
  const txns = generateDemo(opts);
  const insert = db.prepare(`
    INSERT INTO transactions
      (id, occurred_at, amount_cents, currency, merchant, description, source, seed_category, seed_recurring)
    VALUES (?, ?, ?, 'USD', ?, ?, 'seed', ?, ?)
  `);
  db.exec('BEGIN');
  try {
    db.prepare("DELETE FROM transactions WHERE source = 'seed'").run();
    for (const t of txns) insert.run(t.id, t.occurred_at, t.amount_cents, t.merchant, t.description, t.seed_category, t.seed_recurring);
    // Never overrides a choice the user already made.
    const pref = db.prepare('INSERT OR IGNORE INTO category_prefs (category, flexible) VALUES (?, 1)');
    for (const category of DEMO_FLEXIBLE) pref.run(category);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return txns.length;
}

// True when the demo history wasn't generated through `end` (never seeded, or a new day has
// started since), so a rolling demo always ends "today".
export function seedIsStale(db, end) {
  const through = db.prepare("SELECT value FROM sync_state WHERE key = 'seeded_through'").get()?.value;
  return !through || through < end;
}

// Seeds only when stale; returns the number of transactions inserted (0 if not needed).
export function seedDemoIfStale(db, opts) {
  if (!seedIsStale(db, opts.end)) return 0;
  const n = seedDemo(db, opts);
  db.prepare("INSERT INTO sync_state (key, value) VALUES ('seeded_through', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(opts.end);
  return n;
}
