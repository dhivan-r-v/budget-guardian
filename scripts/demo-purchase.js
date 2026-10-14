// Makes a real sandbox payment from the app's PayPal account to a sandbox "merchant", so a
// purchase can be shown flowing into Budget Guardian. Sandbox only.
//
// Usage: node --env-file-if-exists=.env scripts/demo-purchase.js --to <merchant sandbox email> --amount 48.20 [--what "Fuel purchase"]
//
// It is sent as a PayPal payout (event code T0001). After PayPal's reporting delay (up to ~3
// hours), the next sync stores it as spending, with the merchant account's business name.

import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createPayout } from '../src/paypal.js';

const { values: args } = parseArgs({
  options: { to: { type: 'string' }, amount: { type: 'string' }, what: { type: 'string', default: 'Purchase' } },
});
if (!/sandbox/.test(process.env.PAYPAL_BASE_URL ?? '')) throw new Error('Refusing to run: PAYPAL_BASE_URL is not the sandbox.');
if (!args.to?.includes('@')) throw new Error('--to must be the merchant sandbox account email');
if (!/^\d+(\.\d{1,2})?$/.test(args.amount ?? '') || Number(args.amount) <= 0) throw new Error('--amount must be like 48.20');
if (/^Budget Guardian/i.test(args.what)) throw new Error('--what must not start with "Budget Guardian" (that marks savings transfers)');
if (args.to.toLowerCase() === process.env.SAVINGS_RECEIVER_EMAIL?.trim().toLowerCase()) {
  throw new Error('--to is the savings account; pick a merchant account so it counts as spending');
}

const p = await createPayout({
  senderBatchId: `demo-${randomUUID()}`,
  receiver: args.to,
  amountCents: Math.round(Number(args.amount) * 100),
  subject: args.what,
  note: args.what,
});
console.log(`Sent $${Number(args.amount).toFixed(2)} to ${args.to} for "${args.what}" (payout ${p.payoutBatchId}, ${p.batchStatus}).`);
console.log('It shows up in Budget Guardian after PayPal reports it (up to ~3 hours) and the next sync runs.');
