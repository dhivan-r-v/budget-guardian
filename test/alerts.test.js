import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setFlexible } from '../src/savings.js';
import { detectSpikes } from '../src/spikes.js';
import { approve } from '../src/approvals.js';
import { runAlerts, listAlerts, emailConfig, maskEmail } from '../src/alerts.js';

const ASOF = '2026-10-13';
const CONFIG = { configured: true, apiKey: 'test', to: 'me@example.com', from: 'Budget Guardian <a@example.com>', appUrl: 'https://bg.example.com' };
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
const fakeSend = ({ fail } = {}) => {
  const sent = [];
  const send = async (alert) => {
    if (fail) throw new Error(fail);
    sent.push(alert);
  };
  return { sent, send };
};
const paypal = { async getBalance() { return { availableCents: 500000, refreshedAt: null }; }, async createPayout() { return { payoutBatchId: 'B1', batchStatus: 'PENDING' }; } };

test('a new spike is emailed once, with exact figures from code', async () => {
  const db = fuelDb();
  const report = detectSpikes(db, { asOf: ASOF });
  const mail = fakeSend();
  assert.deepEqual(await runAlerts(db, report, { config: CONFIG, send: mail.send }), { configured: true, sent: 1, failed: 0 });
  const [alert] = mail.sent;
  assert.equal(alert.key, 'spike:fuel:2026-10');
  assert.match(alert.subject, /^Fuel spending is \d+% above usual this month$/);
  assert.match(alert.body, /you've spent \$260\.00 on fuel/);
  assert.match(alert.body, /Take public transport instead of driving on 3 days: save \$43\.50/);
  assert.match(alert.body, /Open Budget Guardian: https:\/\/bg\.example\.com/);
  assert.match(alert.body, /never moves money without your approval/);

  assert.equal((await runAlerts(db, report, { config: CONFIG, send: mail.send })).sent, 0);
  assert.equal(mail.sent.length, 1);
  assert.equal(listAlerts(db)[0].status, 'sent');
});

test('a failed email is retried on later runs, up to 3 attempts', async () => {
  const db = fuelDb();
  const report = detectSpikes(db, { asOf: ASOF });
  const down = fakeSend({ fail: 'rate limited' });
  for (let i = 0; i < 4; i++) await runAlerts(db, report, { config: CONFIG, send: down.send });
  const [row] = listAlerts(db);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 3);
  assert.equal(row.error, 'rate limited');
  const up = fakeSend();
  await runAlerts(db, report, { config: CONFIG, send: up.send });
  assert.equal(up.sent.length, 0);
});

test('a plan that goes over what it allows is emailed once', async () => {
  const db = fuelDb();
  await approve(db, { optionId: 'fuel:public_transport:3', expectedAmountCents: 4350, asOf: ASOF }, { client: paypal, receiver: 'savings@example.com' });
  const mail = fakeSend();
  await runAlerts(db, detectSpikes(db, { asOf: ASOF }), { config: CONFIG, send: mail.send });
  assert.deepEqual(mail.sent.map((a) => a.kind), ['spike']);

  assert.match(mail.sent[0].body, /You already approved a plan for fuel this month: Public transport instead of driving on 3 days\./);
  assert.doesNotMatch(mail.sent[0].body, /Ways to bring it back down/);

  addFuel(db, '2026-10-20T12:00:00Z', 32000); // the plan allows $300 until Oct 31
  await runAlerts(db, detectSpikes(db, { asOf: '2026-10-21' }), { config: CONFIG, send: mail.send });
  const over = mail.sent.find((a) => a.kind === 'plan_over');
  assert.equal(over.subject, 'Your fuel plan is off track');
  assert.match(over.body, /you've spent \$320\.00 on fuel; the plan allowed \$300\.00 until October 31, so you're \$20\.00 over/);
  await runAlerts(db, detectSpikes(db, { asOf: '2026-10-22' }), { config: CONFIG, send: mail.send });
  assert.equal(mail.sent.filter((a) => a.kind === 'plan_over').length, 1);
});

test('without email settings nothing is sent or recorded', async () => {
  const db = fuelDb();
  const mail = fakeSend();
  const config = emailConfig({});
  assert.equal(config.configured, false);
  assert.deepEqual(await runAlerts(db, detectSpikes(db, { asOf: ASOF }), { config, send: mail.send }), { configured: false, sent: 0, failed: 0 });
  assert.deepEqual(listAlerts(db), []);
});

test('the dashboard only sees a masked address', () => {
  assert.equal(maskEmail('dhivan@example.com'), 'd•••@example.com');
  assert.equal(emailConfig({ RESEND_API_KEY: 'k', ALERT_EMAIL_TO: 'a@b.c', RENDER_EXTERNAL_URL: 'https://x.onrender.com' }).appUrl, 'https://x.onrender.com');
});
