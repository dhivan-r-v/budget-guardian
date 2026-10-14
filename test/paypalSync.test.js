import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { classify, syncPayPal, syncStatus } from '../src/paypalSync.js';
import { ruleLabel, labelPayPalByRules } from '../src/categorizer.js';

const SAVINGS = 'savings@personal.example.com';

// A Transaction Search detail, shaped like the real sandbox responses.
const tx = (id, code, value, extra = {}) => ({
  transaction_info: {
    transaction_id: id,
    transaction_event_code: code,
    transaction_initiation_date: '2026-10-14T09:30:00+0000',
    transaction_amount: { currency_code: 'USD', value: String(value) },
    transaction_status: 'S',
    ...extra.info,
  },
  payer_info: extra.payer ?? {},
  cart_info: extra.cart ?? {},
});

const shell = tx('S1', 'T0006', '-48.20', { payer: { email_address: 'shell@business.example.com', payer_name: { alternate_full_name: 'Shell Gas Station' } }, info: { transaction_subject: 'Fuel purchase' } });
const sample = [
  tx('A', 'T1900', '5000.00', { info: { transaction_subject: 'Initial balance' } }),
  tx('B', 'T0006', '10.00', { payer: { email_address: 'buyer@personal.example.com' } }),
  tx('C', 'T1503', '-27.34'), // hold
  tx('D', 'T0001', '-27.09', { payer: { email_address: SAVINGS }, info: { transaction_note: 'Budget Guardian: Public transport…' } }),
  tx('E', 'T1105', '27.34'), // release
  shell,
  tx('P', 'T0006', '-12.00', { info: { transaction_status: 'P' } }),
];

test('only completed outgoing payments count as spending', () => {
  const kinds = sample.map((d) => classify(d, { savingsReceiver: SAVINGS }).kind);
  assert.deepEqual(kinds, ['income', 'income', 'skipped', 'savings', 'income', 'spending', 'skipped']);
  assert.deepEqual(classify(shell).row, {
    id: 'paypal-S1',
    occurred_at: '2026-10-14T09:30:00Z',
    amount_cents: 4820,
    merchant: 'Shell Gas Station',
    description: 'Fuel purchase',
  });
});

test("Budget Guardian's own savings payouts are recognized even without the savings email", () => {
  const payout = tx('D', 'T0001', '-27.09', { payer: { email_address: 'someone@personal.example.com' }, info: { transaction_note: 'Budget Guardian: Skip Disney+…' } });
  assert.equal(classify(payout).kind, 'savings');
  const otherPayout = tx('F', 'T0001', '-30.00', { payer: { payer_name: { alternate_full_name: 'Roommate' } } });
  assert.equal(classify(otherPayout).kind, 'spending');
});

test('syncing stores spending once, however often it runs', async () => {
  const db = openDb(':memory:');
  const client = { searchTransactions: async () => ({ details: sample, lastRefreshed: '2026-10-14T05:59:59Z' }) };
  const first = await syncPayPal(db, { client, savingsReceiver: SAVINGS, now: new Date('2026-10-14T12:00:00Z') });
  assert.deepEqual(first, { fetched: 7, added: 1, alreadyStored: 0, savings: 1, income: 3, skipped: 2 });
  const second = await syncPayPal(db, { client, savingsReceiver: SAVINGS, now: new Date('2026-10-14T12:15:00Z') });
  assert.equal(second.added, 0);
  assert.equal(second.alreadyStored, 1);

  const rows = db.prepare("SELECT id, amount_cents, merchant, source, category FROM transactions").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: 'paypal-S1', amount_cents: 4820, merchant: 'Shell Gas Station', source: 'paypal', category: null }]);
  const status = syncStatus(db);
  assert.equal(status.lastSyncAt, '2026-10-14T12:15:00.000Z');
  assert.equal(status.paypalRefreshedTo, '2026-10-14T05:59:59Z');
  assert.equal(status.paypalTransactions, 1);
});

test('a failed sync records the error and stores nothing', async () => {
  const db = openDb(':memory:');
  const client = { searchTransactions: async () => { throw Object.assign(new Error('Not authorized'), { details: { name: 'NOT_AUTHORIZED' } }); } };
  await assert.rejects(syncPayPal(db, { client }));
  assert.equal(syncStatus(db).lastError, 'NOT_AUTHORIZED: Not authorized');
  assert.equal(syncStatus(db).paypalTransactions, 0);
});

test('name rules label obvious PayPal merchants when the LLM is unavailable', async () => {
  assert.equal(ruleLabel('Shell Gas Station'), 'fuel');
  assert.equal(ruleLabel('Blue Bottle', 'Coffee'), 'food');
  assert.equal(ruleLabel('Netflix'), 'entertainment');
  assert.equal(ruleLabel('Rent Co'), null);

  const db = openDb(':memory:');
  await syncPayPal(db, { client: { searchTransactions: async () => ({ details: [shell], lastRefreshed: null }) } });
  db.prepare("INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category) VALUES ('s1', '2026-10-01T00:00:00Z', 4000, 'Shell', 'seed', 'fuel')").run();
  assert.equal(labelPayPalByRules(db), 1);
  const labels = db.prepare('SELECT source, category FROM transactions ORDER BY source').all();
  assert.deepEqual(labels.map((r) => [r.source, r.category]), [['paypal', 'fuel'], ['seed', null]]); // seed rows left for the LLM
});
