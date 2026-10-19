import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setFlexible } from '../src/savings.js';
import { detectSpikes } from '../src/spikes.js';
import { approve } from '../src/approvals.js';
import { runAlerts, listAlerts, subscribe, unsubscribe, deviceCount, vapidKeys, candidateAlerts } from '../src/alerts.js';

const ASOF = '2026-10-13';
let seq = 0;

// Fuel spike: usual $160/month, $260 over the first 13 days of October.
function fuelDb() {
  const db = openDb(':memory:');
  for (const m of ['2026-07', '2026-08', '2026-09']) for (const d of ['03', '10', '17', '24']) addFuel(db, `${m}-${d}T12:00:00Z`, 4000);
  for (const d of ['01', '03', '06', '09', '12']) addFuel(db, `2026-10-${d}T12:00:00Z`, 5200);
  setFlexible(db, 'fuel', true);
  return db;
}
function addFuel(db, at, cents) {
  db.prepare(`INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category, seed_recurring) VALUES (?, ?, ?, 'Shell', 'seed', 'fuel', 0)`)
    .run(`t${++seq}`, at, cents);
}
const device = (n) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: { p256dh: `key-${n}`, auth: `auth-${n}` } });

// A fake push service that records what each device was sent; `fail` / `gone` per endpoint.
function fakePush({ fail = new Set(), gone = new Set(), db } = {}) {
  const sent = [];
  const send = async (sub, payload) => {
    if (gone.has(sub.endpoint)) {
      db.prepare('DELETE FROM notification_deliveries WHERE endpoint = ?').run(sub.endpoint);
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(sub.endpoint);
      throw Object.assign(new Error('gone'), { gone: true });
    }
    if (fail.has(sub.endpoint)) throw new Error('push service unavailable');
    sent.push({ endpoint: sub.endpoint, ...payload });
  };
  return { sent, send };
}
const paypal = { async getBalance() { return { availableCents: 500000, refreshedAt: null }; }, async createPayout() { return { payoutBatchId: 'B1', batchStatus: 'PENDING' }; } };

test('a spike reaches each device once, with exact figures from code', async () => {
  const db = fuelDb();
  subscribe(db, device(1));
  subscribe(db, device(2));
  const report = detectSpikes(db, { asOf: ASOF });
  const push = fakePush();
  assert.deepEqual(await runAlerts(db, report, { send: push.send }), { devices: 2, sent: 2, failed: 0 });
  const [first] = push.sent;
  assert.match(first.title, /^Fuel spending is \d+% above usual$/);
  assert.match(first.body, /^Heading for \$\d+\.\d\d this month \(usual \$160\.00\)\. Tap to see ways to save\.$/);
  assert.equal(first.tag, 'spike:fuel:2026-10');

  assert.equal((await runAlerts(db, report, { send: push.send })).sent, 0);
  // A device that turns alerts on later still gets this month's alert, once.
  subscribe(db, device(3));
  assert.equal((await runAlerts(db, report, { send: push.send })).sent, 1);
  assert.equal(push.sent.at(-1).endpoint, device(3).endpoint);
  assert.equal(listAlerts(db)[0].sentTo, 3);
});

test('a failed delivery is retried up to 3 times; a device that is gone is removed', async () => {
  const db = fuelDb();
  subscribe(db, device(1));
  subscribe(db, device(2));
  const report = detectSpikes(db, { asOf: ASOF });
  const push = fakePush({ db, fail: new Set([device(1).endpoint]), gone: new Set([device(2).endpoint]) });
  for (let i = 0; i < 4; i++) await runAlerts(db, report, { send: push.send });
  const row = db.prepare('SELECT status, attempts, error FROM notification_deliveries WHERE endpoint = ?').get(device(1).endpoint);
  assert.deepEqual({ ...row }, { status: 'failed', attempts: 3, error: 'push service unavailable' });
  assert.equal(deviceCount(db), 1);
});

test('a plan that goes over what it allows is alerted once; spike alerts mention the plan', async () => {
  const db = fuelDb();
  subscribe(db, device(1));
  await approve(db, { optionId: 'fuel:public_transport:3', expectedAmountCents: 4350, asOf: ASOF }, { client: paypal, receiver: 'savings@example.com' });
  const push = fakePush();
  await runAlerts(db, detectSpikes(db, { asOf: ASOF }), { send: push.send });
  assert.match(push.sent[0].body, /You already have a plan for it\.$/);

  addFuel(db, '2026-10-20T12:00:00Z', 32000); // the plan allows $300 until Oct 31
  await runAlerts(db, detectSpikes(db, { asOf: '2026-10-21' }), { send: push.send });
  const over = push.sent.find((a) => a.tag.startsWith('plan_over:'));
  assert.equal(over.title, 'Your fuel plan is off track');
  assert.equal(over.body, '$320.00 spent since you approved; the plan allows $300.00 until Oct 31.');
  await runAlerts(db, detectSpikes(db, { asOf: '2026-10-22' }), { send: push.send });
  assert.equal(push.sent.filter((a) => a.tag.startsWith('plan_over:')).length, 1);
});

test('with no devices nothing is sent', async () => {
  const db = fuelDb();
  const push = fakePush();
  assert.deepEqual(await runAlerts(db, detectSpikes(db, { asOf: ASOF }), { send: push.send }), { devices: 0, sent: 0, failed: 0 });
  assert.equal(candidateAlerts(db, detectSpikes(db, { asOf: ASOF })).length, 1);
});

test('only browser push services are accepted as endpoints', () => {
  const db = openDb(':memory:');
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://web.push.apple.com/x', 'https://wns2-par02p.notify.windows.com/w/?token=x']) {
    subscribe(db, { endpoint, keys: { p256dh: 'p', auth: 'a' } });
  }
  assert.equal(deviceCount(db), 4);
  for (const endpoint of ['https://evil.example.com/hook', 'http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.com/x', 'not a url']) {
    assert.throws(() => subscribe(db, { endpoint, keys: { p256dh: 'p', auth: 'a' } }), RangeError);
  }
  assert.throws(() => subscribe(db, { endpoint: 'https://fcm.googleapis.com/x' }), RangeError);
  unsubscribe(db, 'https://fcm.googleapis.com/fcm/send/x');
  assert.equal(deviceCount(db), 3);
});

test('VAPID keys are generated once and kept', () => {
  const db = openDb(':memory:');
  const keys = vapidKeys(db, {});
  assert.equal(keys.publicKey.length, 87);
  assert.deepEqual(vapidKeys(db, {}), keys);
  assert.deepEqual(vapidKeys(db, { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' }), { publicKey: 'pub', privateKey: 'priv' });
});
