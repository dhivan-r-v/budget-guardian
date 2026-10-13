// Prints the spike report, with causes, for the local database.
// Usage: node scripts/spikes.js [--as-of YYYY-MM-DD]

import { parseArgs } from 'node:util';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';
import { explainSpikes } from '../src/causes.js';

const { values: args } = parseArgs({ options: { 'as-of': { type: 'string' } } });
const db = openDb();
const report = explainSpikes(db, detectSpikes(db, args['as-of'] ? { asOf: args['as-of'] } : {}));
db.close();

const usd = (cents) => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
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

for (const { category, increaseCents, cause } of report.spikes) {
  const o = cause.oneOff;
  console.log(`\n${category}: +${usd(increaseCents)}, main cause: ${cause.primaryCause}`);
  console.log(`  more often:    ${usd(o.moreOftenCents)}  (${o.count} purchases so far vs ${o.expectedCount} usual by today, ${o.usualMonthlyCount}/month)`);
  console.log(`  higher prices: ${usd(o.higherPricesCents)}  (average ${usd(o.averageAmountCents)} vs usual ${usd(o.usualAmountCents)})`);
  console.log(`  recurring:     ${usd(cause.recurring.excessCents)}`);
  for (const t of cause.recurring.newSubscriptions) console.log(`    new subscription: ${t.merchant} ${usd(t.amountCents)}`);
  for (const t of cause.recurring.priceIncreases) {
    console.log(`    price increase: ${t.merchant} ${usd(t.usualAmountCents)} -> ${usd(t.amountCents)}`);
  }
  for (const t of cause.largePurchases) console.log(`  large purchase: ${t.date} ${t.merchant} ${usd(t.amountCents)}`);
  console.log('  purchases:');
  for (const t of cause.transactions) console.log(`    ${t.date}  ${t.merchant.padEnd(16)} ${usd(t.amountCents)}`);
}
