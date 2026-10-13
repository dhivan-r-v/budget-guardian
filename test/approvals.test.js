import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setFlexible } from '../src/savings.js';
import { PayPalError } from '../src/paypal.js';
import { approve, retry, refresh, listApprovals } from '../src/approvals.js';

const ASOF = '2026-10-13';
const RECEIVER = 'savings@personal.example.com';
let seq = 0;

// Fuel spike: usual $160/month; $260 over 13 days ($20/day). 3 transit days saves $43.50.
function fuelDb() {
  const db = openDb(':memory:');
  const insert = db.prepare(`
    INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category, seed_recurring)
    VALUES (?, ?, ?, 'Shell', 'seed', 'fuel', 0)
  `);
  for (const m of ['2026-07', '2026-08', '2026-09']) {
    for (const d of ['03', '10', '17', '24']) insert.run(`t${++seq}`, `${m}-${d}T12:00:00Z`, 4000);
  }
  for (const d of ['01', '03', '06', '09', '12']) insert.run(`t${++seq}`, `2026-10-${d}T12:00:00Z`, 5200);
  setFlexible(db, 'fuel', true);
  return db;
}

// A fake PayPal that records payouts; `fail` makes createPayout throw.
function fakePayPal({ fail, status = 'PENDING', item = 'SUCCESS' } = {}) {
  const payouts = [];
  return {
    payouts,
    async createPayout(p) {
      if (fail) throw fail;
      payouts.push(p);
      return { payoutBatchId: `BATCH-${payouts.length}`, batchStatus: status };
    },
    async getPayout() {
      return { batchStatus: 'SUCCESS', itemStatus: item };
    },
  };
}

const OPTION = 'fuel:public_transport:3';
const request = (over = {}) => ({ optionId: OPTION, expectedAmountCents: 4350, asOf: ASOF, ...over });

test('approving sends exactly the recomputed amount to the savings account', async () => {
  const db = fuelDb();
  const client = fakePayPal();
  const { approval, duplicate } = await approve(db, request(), { client, receiver: RECEIVER });
  assert.equal(duplicate, false);
  assert.equal(approval.status, 'sent');
  assert.equal(approval.amountCents, 4350);
  assert.equal(approval.description, 'Public transport instead of driving on 3 days');
  assert.equal(approval.payoutBatchId, 'BATCH-1');
  assert.equal(client.payouts.length, 1);
  assert.deepEqual(
    { id: client.payouts[0].senderBatchId, to: client.payouts[0].receiver, cents: client.payouts[0].amountCents },
    { id: approval.id, to: RECEIVER, cents: 4350 },
  );
});

test('nothing is sent when the amount shown to the user is out of date', async () => {
  const db = fuelDb();
  const client = fakePayPal();
  await assert.rejects(approve(db, request({ expectedAmountCents: 9999 }), { client, receiver: RECEIVER }), (err) => {
    assert.equal(err.status, 409);
    assert.deepEqual(err.details, { amountCents: 4350 });
    return true;
  });
  assert.equal(client.payouts.length, 0);
  assert.deepEqual(listApprovals(db), []);
});

test('approving the same option twice in a month pays once', async () => {
  const db = fuelDb();
  const client = fakePayPal();
  const first = await approve(db, request(), { client, receiver: RECEIVER });
  const second = await approve(db, request(), { client, receiver: RECEIVER });
  assert.equal(second.duplicate, true);
  assert.equal(second.approval.id, first.approval.id);
  assert.equal(client.payouts.length, 1);
});

test('categories not marked flexible, and unknown options, are refused', async () => {
  const db = fuelDb();
  const client = fakePayPal();
  await assert.rejects(approve(db, request({ optionId: 'fuel:sell_the_car' }), { client, receiver: RECEIVER }), { status: 404 });
  setFlexible(db, 'fuel', false);
  await assert.rejects(approve(db, request(), { client, receiver: RECEIVER }), { status: 403 });
  assert.equal(client.payouts.length, 0);
});

test('without a savings account configured, nothing is sent', async () => {
  await assert.rejects(approve(fuelDb(), request(), { client: fakePayPal(), receiver: '' }), { status: 503 });
});

test('a PayPal refusal marks the approval failed, and it can be approved again', async () => {
  const db = fuelDb();
  const refused = await approve(db, request(), { client: fakePayPal({ fail: new PayPalError(422, { name: 'INSUFFICIENT_FUNDS', message: 'Sender does not have sufficient funds.' }) }), receiver: RECEIVER });
  assert.equal(refused.approval.status, 'failed');
  assert.match(refused.approval.error, /INSUFFICIENT_FUNDS/);

  const client = fakePayPal();
  const again = await approve(db, request(), { client, receiver: RECEIVER });
  assert.equal(again.duplicate, false);
  assert.equal(again.approval.status, 'sent');
  assert.equal(client.payouts.length, 1);
});

test('a network error keeps the approval and retries it with the same id', async () => {
  const db = fuelDb();
  const down = await approve(db, request(), { client: fakePayPal({ fail: new Error('fetch failed') }), receiver: RECEIVER });
  assert.equal(down.approval.status, 'approved');
  assert.match(down.approval.error, /fetch failed/);

  // A new approval of the same option is blocked while this one is unresolved.
  const blocked = await approve(db, request(), { client: fakePayPal(), receiver: RECEIVER });
  assert.equal(blocked.duplicate, true);

  const client = fakePayPal();
  const sent = await retry(db, down.approval.id, { client });
  assert.equal(sent.status, 'sent');
  assert.equal(client.payouts[0].senderBatchId, down.approval.id);
});

test('refresh moves a sent payout to completed or failed from PayPal status', async () => {
  const db = fuelDb();
  const { approval } = await approve(db, request(), { client: fakePayPal(), receiver: RECEIVER });
  assert.equal((await refresh(db, approval.id, { client: fakePayPal({ item: 'UNCLAIMED' }) })).status, 'sent');
  const done = await refresh(db, approval.id, { client: fakePayPal({ item: 'SUCCESS' }) });
  assert.equal(done.status, 'completed');
  assert.equal(done.paypalStatus, 'SUCCESS');

  const db2 = fuelDb();
  const r2 = await approve(db2, request(), { client: fakePayPal(), receiver: RECEIVER });
  assert.equal((await refresh(db2, r2.approval.id, { client: fakePayPal({ item: 'RETURNED' }) })).status, 'failed');
});

test('a completed approval cannot be retried', async () => {
  const db = fuelDb();
  const { approval } = await approve(db, request(), { client: fakePayPal(), receiver: RECEIVER });
  await assert.rejects(retry(db, approval.id, { client: fakePayPal() }), { status: 409 });
});
