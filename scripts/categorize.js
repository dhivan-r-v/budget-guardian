// Labels uncategorized transactions with the LLM and reports accuracy against seed labels.
// Usage: node --env-file-if-exists=.env scripts/categorize.js [--reset]

import { parseArgs } from 'node:util';
import { openDb } from '../src/db.js';
import { categorize, accuracy, resetLabels, pendingGroups } from '../src/categorizer.js';
import { aiAvailable, AI_MODEL } from '../src/ai.js';

const { values: args } = parseArgs({ options: { reset: { type: 'boolean', default: false } } });
const db = openDb();
if (args.reset) console.log(`Cleared labels on ${resetLabels(db)} transactions.`);

console.log(aiAvailable() ? `Using ${AI_MODEL}.` : 'No GEMINI_API_KEY: nothing will be labeled.');
const started = Date.now();
const r = await categorize(db);
console.log(
  `${r.groups} merchant groups pending -> labeled ${r.labeledGroups} (${r.labeledTransactions} transactions) ` +
    `with ${r.requests} request(s), ${r.cachedBatches} from cache, in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
);
for (const e of r.errors) console.log(`  error: ${e.slice(0, 200)}`);
const left = pendingGroups(db);
if (left.length) console.log(`Still unlabeled: ${left.map((g) => g.merchant).join(', ')} (run again later).`);

const a = accuracy(db);
if (a.labeled) {
  console.log(`\nAccuracy on ${a.labeled} seed transactions: category ${a.categoryAccuracyPct}%, recurring ${a.recurringAccuracyPct}%.`);
  for (const m of a.mismatches) {
    console.log(
      `  ${m.merchant} (${m.description}): got ${m.category}${m.recurring ? ', recurring' : ''}; ` +
        `expected ${m.expected}${m.expectedRecurring ? ', recurring' : ''} [${m.transactions} txns]`,
    );
  }
}
db.close();
