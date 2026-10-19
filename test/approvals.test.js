import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setFlexible } from '../src/savings.js';
import { PayPalError } from '../src/paypal.js';
import { approve, retry, refresh, listApprovals, followThrough } from '../src/approvals.js';

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
function fakePayPal({ fail, status = 'PENDING', item = 'SUCCESS', balanceCents = 500000, refreshedAt = null, balanceError } = {}) {
  const payouts = [];
  return {
    payouts,
    async getBalance() {
      if (balanceError) throw balanceError;
      return { availableCents: balanceCents, refreshedAt };
    },
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

test('options in a category are alternatives: only one plan per category per month', async () => {
  const db = fuelDb();
  const client = fakePayPal();
  const { approval } = await approve(db, request(), { client, receiver: RECEIVER }); // 3 days
  await assert.rejects(
    approve(db, request({ optionId: 'fuel:public_transport:2', expectedAmountCents: 2900 }), { client, receiver: RECEIVER }),
    (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /already approved a fuel plan this month: Public transport instead of driving on 3 days/);
      assert.equal(err.details.approvalId, approval.id);
      return true;
    },
  );
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

// --- Balance check

test('nothing moves when it would leave the PayPal balance below the $50 cushion', async () => {
  const db = fuelDb();
  const client = fakePayPal({ balanceCents: 9000 }); // $90 - $43.50 = $46.50 left
  await assert.rejects(approve(db, request(), { client, receiver: RECEIVER }), (err) => {
    assert.equal(err.status, 422);
    assert.match(err.message, /balance is \$90\.00, and moving \$43\.50 would leave less than the \$50\.00/);
    return true;
  });
  assert.equal(client.payouts.length, 0);
  assert.deepEqual(listApprovals(db), []);

  const enough = await approve(db, request(), { client: fakePayPal({ balanceCents: 9350 }), receiver: RECEIVER });
  assert.equal(enough.approval.status, 'sent');
});

test('nothing moves when the balance cannot be read', async () => {
  const db = fuelDb();
  const client = fakePayPal({ balanceError: new Error('fetch failed') });
  await assert.rejects(approve(db, request(), { client, receiver: RECEIVER }), { status: 503 });
  assert.equal(client.payouts.length, 0);
  assert.deepEqual(listApprovals(db), []);
});

test('transfers approved since PayPal last refreshed the balance are subtracted from it', async () => {
  const db = fuelDb();
  db.prepare(`INSERT INTO approvals (id, option_id, category, month, description, amount_cents, receiver, status, created_at)
    VALUES ('earlier', 'food:cut_back:50', 'food', '2026-10', 'Spend less on food', 5000, ?, 'sent', '2026-10-13T10:00:00Z')`).run(RECEIVER);
  // $140 reported, but $50 already left after the refresh: $90 - $43.50 is under the cushion.
  const stale = fakePayPal({ balanceCents: 14000, refreshedAt: '2026-10-13T09:00:00Z' });
  await assert.rejects(approve(db, request(), { client: stale, receiver: RECEIVER }), { status: 422 });
  const fresh = fakePayPal({ balanceCents: 14000, refreshedAt: '2026-10-13T11:00:00Z' });
  assert.equal((await approve(db, request(), { client: fresh, receiver: RECEIVER })).approval.status, 'sent');
});

// --- Follow-through

const addFuel = (db, at, cents) =>
  db.prepare(`INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category, seed_recurring) VALUES (?, ?, ?, 'Shell', 'seed', 'fuel', 0)`)
    .run(`t${++seq}`, at, cents);

test('a transit plan allows the current fuel rate for the rest of the month, minus the fuel it avoids', async () => {
  const db = fuelDb();
  const { approval } = await approve(db, request(), { client: fakePayPal(), receiver: RECEIVER });
  // $20/day for the 18 days left is $360; 3 transit days avoid $60 of it.
  assert.equal(approval.planAllowanceCents, 30000);
  assert.equal(approval.planSince, '2026-10-13T23:59:59Z');

  addFuel(db, '2026-10-13T12:00:00Z', 9000); // before the plan started: not counted
  addFuel(db, '2026-10-16T12:00:00Z', 12000);
  assert.deepEqual(followThrough(db, approval, { asOf: '2026-10-20' }), {
    kind: 'cap', allowanceCents: 30000, spentCents: 12000, leftCents: 18000, endsOn: '2026-10-31', monthEnded: false, status: 'on_track',
  });
  addFuel(db, '2026-10-25T12:00:00Z', 19000);
  assert.equal(followThrough(db, approval, { asOf: '2026-10-20' }).spentCents, 12000); // not yet happened
  assert.equal(followThrough(db, approval, { asOf: '2026-10-26' }).status, 'over');
  assert.equal(followThrough(db, approval, { asOf: '2026-11-02' }).status, 'missed');
  addFuel(db, '2026-11-01T12:00:00Z', 50000); // next month: not part of the plan
  assert.equal(followThrough(db, approval, { asOf: '2026-11-02' }).spentCents, 31000);
});

test('a plan kept until the month ends is reported as kept', async () => {
  const db = fuelDb();
  const { approval } = await approve(db, request(), { client: fakePayPal(), receiver: RECEIVER });
  addFuel(db, '2026-10-20T12:00:00Z', 15000);
  assert.equal(followThrough(db, approval, { asOf: '2026-11-01' }).status, 'kept');
});

test('a skip-subscriptions plan goes off track when a skipped subscription bills', async () => {
  const db = openDb(':memory:');
  const insert = db.prepare(`INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category, seed_recurring) VALUES (?, ?, ?, ?, 'seed', 'entertainment', 1)`);
  for (const m of ['2026-08', '2026-09']) {
    insert.run(`t${++seq}`, `${m}-05T12:00:00Z`, 1099, 'Spotify');
    insert.run(`t${++seq}`, `${m}-20T12:00:00Z`, 1549, 'Netflix');
  }
  insert.run(`t${++seq}`, '2026-10-05T12:00:00Z', 1099, 'Spotify');
  setFlexible(db, 'entertainment', true);

  const { approval } = await approve(db, { optionId: 'entertainment:skip_subscriptions', expectedAmountCents: 1549, asOf: ASOF }, { client: fakePayPal(), receiver: RECEIVER });
  assert.deepEqual(approval.planMerchants, ['Netflix']);
  assert.equal(followThrough(db, approval, { asOf: '2026-10-19' }).status, 'on_track');
  insert.run(`t${++seq}`, '2026-10-20T12:00:00Z', 1549, 'Netflix');
  const f = followThrough(db, approval, { asOf: '2026-10-21' });
  assert.equal(f.status, 'over');
  assert.deepEqual(f.billedMerchants, ['Netflix']);
});

test('failed approvals have no follow-through', async () => {
  const db = fuelDb();
  const { approval } = await approve(db, request(), { client: fakePayPal({ fail: new PayPalError(422, { message: 'no' }) }), receiver: RECEIVER });
  assert.equal(followThrough(db, approval, { asOf: '2026-10-20' }), null);
});
