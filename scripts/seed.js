// Seeds realistic spending history, since PayPal sandbox accounts start empty.
//
// Usage: node scripts/seed.js [--months 5] [--end YYYY-MM-DD] [--seed 42] [--if-stale]
//
// See src/seed.js for what is generated. --if-stale only reseeds when the demo history wasn't
// generated through --end (default: today), which keeps a long-running demo current.
// PayPal rows and approvals are never touched.

import { parseArgs } from 'node:util';
import { openDb, DB_PATH } from '../src/db.js';
import { seedDemo, seedDemoIfStale } from '../src/seed.js';
import { today } from '../src/spikes.js';

const { values: args } = parseArgs({
  options: {
    months: { type: 'string', default: '5' },
    end: { type: 'string', default: today() },
    seed: { type: 'string', default: '42' },
    'if-stale': { type: 'boolean', default: false },
  },
});
const opts = { months: Number(args.months), end: args.end, seed: Number(args.seed) };

const db = openDb();
const inserted = args['if-stale'] ? seedDemoIfStale(db, opts) : seedDemo(db, opts);
if (!inserted) {
  console.log(`Demo history in ${DB_PATH} already runs through ${opts.end}; not reseeding.`);
  process.exit(0);
}
if (!args['if-stale']) {
  db.prepare("INSERT INTO sync_state (key, value) VALUES ('seeded_through', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(opts.end);
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
console.log(`Seeded ${inserted} transactions into ${DB_PATH} (latest month runs to ${opts.end}).`);
console.table(summary);
db.close();
