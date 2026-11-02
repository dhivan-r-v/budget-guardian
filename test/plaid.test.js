import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { labelByRules, ruleLabel } from '../src/categorizer.js';
import { classify, connect, disconnect, syncPlaid, listItems, plaidConfig } from '../src/plaid.js';

// Plaid transaction: amount is positive for money out.
const tx = (id, amount, extra = {}) => ({
  transaction_id: id,
  amount,
  date: '2026-10-20',
  authorized_date: '2026-10-19',
  name: 'SHELL OIL 57444',
  merchant_name: 'Shell',
  iso_currency_code: 'USD',
  pending: false,
  personal_finance_category: { primary: 'TRANSPORTATION', detailed: 'TRANSPORTATION_GAS' },
  ...extra,
});

// A fake Plaid: `pages` are the /transactions/sync responses, served in order per cursor.
function fakePlaid(pages = []) {
  const calls = [];
  return {
    calls,
    removed: [],
    async exchange(publicToken) { calls.push(['exchange', publicToken]); return { accessToken: 'access-sandbox-1', itemId: 'item-1' }; },
    async accounts() { return [{ name: 'Plaid Credit Card', mask: '3333', subtype: 'credit card' }]; },
    async sync(accessToken, cursor) {
      calls.push(['sync', cursor ?? null]);
      const page = pages.shift();
      if (page instanceof Error) throw page;
      return page ?? { added: [], modified: [], removed: [], next_cursor: cursor, has_more: false };
    },
    async remove(accessToken) { this.removed.push(accessToken); },
  };
}

test('only posted USD spending counts', () => {
  assert.equal(classify(tx('a', 48.2)).kind, 'spending');
  assert.equal(classify(tx('b', -500)).kind, 'income');
  assert.equal(classify(tx('c', 48.2, { pending: true })).reason, 'pending');
  assert.equal(classify(tx('d', 48.2, { iso_currency_code: 'EUR' })).reason, 'not USD');
  assert.equal(classify(tx('e', 600, { personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } })).kind, 'skipped');
  assert.equal(classify(tx('f', 200, { personal_finance_category: { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_ACCOUNT_TRANSFER' } })).kind, 'skipped');
  assert.equal(classify(tx('g', 42, { name: 'PAYPAL *SHELLOIL', merchant_name: null })).kind, 'paypal');
});

test('Plaid categories label rows the name rules would miss', () => {
  assert.equal(ruleLabel('Kwik Trip', 'KWIK TRIP 123 · TRANSPORTATION_GAS'), 'fuel');
  assert.equal(ruleLabel('Sparkfun', 'SPARKFUN · GENERAL_MERCHANDISE_ELECTRONICS'), 'shopping');
  assert.equal(ruleLabel('Mathnasium', 'Mathnasium · GENERAL_SERVICES_EDUCATION'), 'education');
  assert.equal(ruleLabel('Touchstone', 'TOUCHSTONE CLIMBING · ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS'), 'entertainment');
});

test('connect stores the item server-side; sync adds, updates and removes with the cursor', async () => {
  const db = openDb(':memory:');
  const client = fakePlaid([
    { added: [tx('t1', 48.2), tx('t2', 12.5, { name: 'STARBUCKS 1', merchant_name: 'Starbucks', personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' } })], modified: [], removed: [], next_cursor: 'c1', has_more: true },
    { added: [tx('t3', 600, { personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } }), tx('t4', -1000)], modified: [], removed: [], next_cursor: 'c2', has_more: false },
    { added: [], modified: [tx('t1', 50.1)], removed: [{ transaction_id: 't2' }], next_cursor: 'c3', has_more: false },
  ]);
  assert.equal(await connect(db, { publicToken: 'public-sandbox-x', institution: 'First Platypus Bank' }, { client }), 'item-1');
  const [item] = listItems(db);
  assert.equal(item.institution, 'First Platypus Bank');
  assert.deepEqual(item.accounts, [{ name: 'Plaid Credit Card', mask: '3333', type: 'credit card' }]);
  assert.equal(item.access_token, undefined); // never listed

  const [first] = await syncPlaid(db, { client });
  assert.deepEqual(first, { itemId: 'item-1', added: 2, updated: 0, removed: 0, paypal: 0, income: 1, skipped: 1 });
  const rows = db.prepare("SELECT id, occurred_at, amount_cents, merchant, description, import_id FROM transactions WHERE source = 'plaid' ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(rows[0], { id: 'plaid-t1', occurred_at: '2026-10-19T12:00:00Z', amount_cents: 4820, merchant: 'Shell', description: 'SHELL OIL 57444 · TRANSPORTATION_GAS', import_id: 'item-1' });

  const [second] = await syncPlaid(db, { client });
  assert.deepEqual([second.updated, second.removed], [1, 1]);
  assert.deepEqual(db.prepare("SELECT id, amount_cents FROM transactions WHERE source = 'plaid'").all().map((r) => [r.id, r.amount_cents]), [['plaid-t1', 5010]]);
  assert.deepEqual(client.calls.filter((c) => c[0] === 'sync').map((c) => c[1]), [null, 'c1', 'c2']);

  labelByRules(db);
  assert.equal(db.prepare("SELECT category FROM transactions WHERE id = 'plaid-t1'").get().category, 'fuel');
});

test('a failed sync applies nothing and keeps the cursor, so the next sync retries', async () => {
  const db = openDb(':memory:');
  const client = fakePlaid([
    { added: [tx('t1', 48.2)], modified: [], removed: [], next_cursor: 'c1', has_more: true },
    new Error('ITEM_LOGIN_REQUIRED'),
    { added: [tx('t1', 48.2)], modified: [], removed: [], next_cursor: 'c1', has_more: false },
  ]);
  await connect(db, { publicToken: 'p' }, { client });
  const [failed] = await syncPlaid(db, { client });
  assert.equal(failed.error, 'ITEM_LOGIN_REQUIRED');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'plaid'").get().n, 0);
  assert.equal(listItems(db)[0].error, 'ITEM_LOGIN_REQUIRED');
  const [ok] = await syncPlaid(db, { client });
  assert.equal(ok.added, 1);
  assert.equal(listItems(db)[0].error, null);
});

test('disconnecting removes the connection at Plaid and its transactions', async () => {
  const db = openDb(':memory:');
  const client = fakePlaid([{ added: [tx('t1', 48.2)], modified: [], removed: [], next_cursor: 'c1', has_more: false }]);
  await connect(db, { publicToken: 'p' }, { client });
  await syncPlaid(db, { client });
  assert.deepEqual(await disconnect(db, 'item-1', { client }), { removed: 1 });
  assert.deepEqual(client.removed, ['access-sandbox-1']);
  assert.deepEqual(listItems(db), []);
  await assert.rejects(disconnect(db, 'item-1', { client }), { status: 404 });
});

test('Plaid is off without keys', () => {
  assert.equal(plaidConfig({}).configured, false);
  assert.equal(plaidConfig({ PLAID_CLIENT_ID: 'id', PLAID_SECRET: 's' }).env, 'sandbox');
  assert.equal(plaidConfig({ PLAID_CLIENT_ID: 'id', PLAID_SECRET: 's', PLAID_ENV: 'production' }).base, 'https://production.plaid.com');
});
