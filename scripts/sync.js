// Syncs PayPal transactions now, labels new merchants, and prints what happened.
// Usage: node --env-file-if-exists=.env scripts/sync.js

import { openDb } from '../src/db.js';
import { syncPayPal, syncStatus } from '../src/paypalSync.js';
import { categorize, labelPayPalByRules } from '../src/categorizer.js';

const db = openDb();
const r = await syncPayPal(db);
console.log(`PayPal: ${r.fetched} transactions in the last 90 days -> ${r.added} new spending, ${r.alreadyStored} already stored, ` +
  `${r.savings} savings transfers, ${r.income} money in, ${r.skipped} skipped (holds, fees, pending).`);
const labels = await categorize(db);
const byRules = labelPayPalByRules(db);
console.log(`Labeled ${labels.labeledTransactions} by AI${labels.errors.length ? ` (AI: ${labels.errors[0].slice(0, 80)})` : ''}, ${byRules} by name rules.`);
const s = syncStatus(db);
console.log(`PayPal data is refreshed up to ${s.paypalRefreshedTo}; ${s.paypalTransactions} PayPal transactions stored.`);
for (const t of db.prepare("SELECT occurred_at, merchant, description, amount_cents, category FROM transactions WHERE source = 'paypal' ORDER BY occurred_at").all()) {
  console.log(`  ${t.occurred_at.slice(0, 10)}  ${t.merchant.padEnd(22)} ${(t.description ?? '').padEnd(18)} $${(t.amount_cents / 100).toFixed(2)}  ${t.category ?? 'unlabeled'}`);
}
db.close();
