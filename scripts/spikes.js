// Prints the spike report, with causes, savings options and habits, for the local database.
// Usage: node scripts/spikes.js [--as-of YYYY-MM-DD]

import { parseArgs } from 'node:util';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';
import { explainSpikes } from '../src/causes.js';
import { suggestSavings } from '../src/savings.js';
import { habitInsights } from '../src/habits.js';
import { usd } from '../src/advisor.js';

const { values: args } = parseArgs({ options: { 'as-of': { type: 'string' } } });
const db = openDb();
const report = explainSpikes(db, detectSpikes(db, args['as-of'] ? { asOf: args['as-of'] } : {}));
const savings = report.categories.map((c) => suggestSavings(db, report, c)).filter((s) => s.flexible);
const habits = habitInsights(db, report);
db.close();

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

for (const s of savings) {
  console.log(`
Savings for ${s.category}:`);
  if (!s.options.length) console.log('  (no options right now)');
  for (const o of s.options) {
    const covers = o.coversPctOfIncrease === null || s.increaseCents <= 0 ? '' : `, covers ${o.coversPctOfIncrease}% of the increase`;
    if (o.type === 'public_transport') {
      console.log(`  Public transport ${o.transitDays} days: save ${usd(o.savingsCents)} (${usd(o.fuelAvoidedCents)} fuel - ${usd(o.transitCostCents)} fares), ${o.co2AvoidedKg} kg CO2 avoided${covers}`);
    } else if (o.type === 'skip_subscriptions') {
      console.log(`  Skip subscriptions not billed yet: save ${usd(o.savingsCents)} this month${covers}`);
      for (const x of o.subscriptions) {
        console.log(`    ${x.merchant.padEnd(16)} ${usd(x.amountCents)}  day ${x.billingDay}  ${x.chargedThisMonth ? 'already billed' : 'save ' + usd(x.savingsThisMonthCents)}`);
      }
    } else {
      console.log(`  Cut back ${o.percent}% for the rest of the month: save ${usd(o.savingsCents)}${covers}`);
    }
  }
  if (s.assumptions?.dailyFuelCents !== undefined) {
    const a = s.assumptions;
    console.log(`  Assumes ${usd(a.dailyFuelCents)}/day fuel this month, ${usd(a.transitFarePerDayCents)}/day fares, gas ${usd(a.gasPricePerGallonCents)}/gal, ${a.co2KgPerGallon} kg CO2/gal, ${a.remainingDays} days left.`);
  }
}

console.log('\nHabits (small, frequent purchases in flexible categories):');
if (!habits.length) console.log('  (none)');
for (const h of habits) {
  console.log(
    `  ${h.label} (${h.category}; ${h.merchants.join(', ')}): ${h.perMonth}x/month at ${usd(h.averageCents)} = ${usd(h.monthlyCents)}/month, ${usd(h.yearlyCents)}/year. ` +
      `This month so far: ${h.thisMonth.count}x, ${usd(h.thisMonth.cents)}.`,
  );
  console.log(`    Cut to ${h.cutBack.perMonth}x/month: save ${usd(h.cutBack.savingsPerMonthCents)}/month, ${usd(h.cutBack.savingsPerYearCents)}/year.`);
}
