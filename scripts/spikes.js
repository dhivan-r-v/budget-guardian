// Prints the spike report for the local database.
// Usage: node scripts/spikes.js [--as-of YYYY-MM-DD]

import { parseArgs } from 'node:util';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';

const { values: args } = parseArgs({ options: { 'as-of': { type: 'string' } } });
const db = openDb();
const report = detectSpikes(db, args['as-of'] ? { asOf: args['as-of'] } : {});
db.close();

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
console.log(
  `${report.month}, day ${report.daysElapsed} of ${report.daysInMonth}. ` +
    `Baseline: ${report.baselineMonths.join(', ') || 'none'}.`,
);
console.table(
  report.categories.map((c) => ({
    category: c.category,
    usual: usd(c.baselineAvgCents),
    'so far': usd(c.currentCents),
    projected: usd(c.projectedCents),
    change: c.increasePct === null ? 'new' : `${c.increasePct > 0 ? '+' : ''}${c.increasePct}%`,
    txns: `${c.transactionCount} (usual ${c.baselineAvgTransactionCount})`,
    spike: c.isSpike ? 'YES' : '',
  })),
);
