// Demo helper: a card purchase on the connected Plaid sandbox account, through the server.
// The server must be in the Plaid sandbox with an account connected as user_transactions_dynamic.
// Usage: npm run plaid-purchase -- --amount 89.40 --what "SHELL OIL 57444" [--url https://...]
// Uses ADMIN_TOKEN from .env (needed when the server has one, e.g. on Render).
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    amount: { type: 'string' },
    what: { type: 'string' },
    url: { type: 'string', default: `http://localhost:${process.env.PORT ?? 3000}` },
  },
});
if (!args.amount || !args.what) {
  console.error('Usage: npm run plaid-purchase -- --amount 89.40 --what "SHELL OIL 57444" [--url https://...]');
  process.exit(1);
}
const token = process.env.ADMIN_TOKEN?.trim();
const res = await fetch(`${args.url.replace(/\/$/, '')}/api/plaid/sandbox-purchase`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
  body: JSON.stringify({ amount: Number(args.amount), description: args.what }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`Failed (${res.status}): ${body.error ?? res.statusText}`);
  process.exit(1);
}
console.log(`Card purchase of $${Number(body.amount).toFixed(2)} at "${body.description}" on ${body.institution} (${body.date}). It syncs within a minute.`);
