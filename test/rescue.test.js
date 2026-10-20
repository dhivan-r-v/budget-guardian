import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { setFlexible } from '../src/savings.js';
import { setBudget } from '../src/budget.js';
import { detectSpikes } from '../src/spikes.js';
import { rescuePlan, rescueIdle, rulesPlan, situation, approveRescue } from '../src/rescue.js';

const ASOF = '2026-10-13';
let seq = 0;

// Fuel spikes ($260 in 13 days, usual $160/month): transit 2 days saves $29.00, 3 days $43.50.
// Food is steady at $200/month: cutting back 25% saves $29.03, 50% saves $58.07.
// Projected month: fuel $352.90 + food $221.13 = $574.03, $69.03 over a $505 budget.
function demoDb({ budgetCents = 50500 } = {}) {
  const db = openDb(':memory:');
  const add = db.prepare(`INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category, seed_recurring) VALUES (?, ?, ?, ?, 'seed', ?, 0)`);
  for (const m of ['2026-07', '2026-08', '2026-09']) {
    for (const d of ['03', '10', '17', '24']) add.run(`t${++seq}`, `${m}-${d}T12:00:00Z`, 4000, 'Shell', 'fuel');
    for (const d of ['02', '06', '12', '16', '20', '24', '26', '28']) add.run(`t${++seq}`, `${m}-${d}T12:00:00Z`, 2500, 'Grocer', 'food');
  }
  for (const d of ['01', '03', '06', '09', '12']) add.run(`t${++seq}`, `2026-10-${d}T12:00:00Z`, 5200, 'Shell', 'fuel');
  for (const d of ['02', '06', '12']) add.run(`t${++seq}`, `2026-10-${d}T12:00:00Z`, 3500, 'Grocer', 'food');
  setFlexible(db, 'fuel', true);
  setFlexible(db, 'food', true);
  if (budgetCents) setBudget(db, budgetCents);
  return db;
}
const report = (db) => detectSpikes(db, { asOf: ASOF });

// A scripted model: each turn returns the next list of tool calls, and records what it saw.
function scripted(turns) {
  const seen = [];
  const turn = async ({ contents }) => {
    seen.push(contents.at(-1));
    const next = turns.shift();
    if (!next) throw new Error('script ran out');
    if (next instanceof Error) throw next;
    return { content: { role: 'model', parts: next.map((c) => ({ functionCall: c })) }, calls: next };
  };
  return { turn, seen };
}
const call = (name, args = {}) => ({ name, args });

test('the situation: overspend, what is left to cover, and options only in flexible categories', () => {
  const db = demoDb();
  setFlexible(db, 'food', false);
  const sit = situation(db, report(db));
  assert.equal(sit.overCents, 6903);
  assert.equal(sit.gapCents, 6903);
  assert.deepEqual([...sit.options.keys()], ['fuel:public_transport:2', 'fuel:public_transport:3']);
});

test('no plan without a budget, or when the month is on track', async () => {
  assert.equal((await rescuePlan(demoDb({ budgetCents: null }), report(demoDb()), { useAI: false })).status, 'no_budget');
  const db = demoDb({ budgetCents: 70000 });
  assert.equal((await rescuePlan(db, report(db), { useAI: false })).status, 'on_track');
});

test('rules plan: the largest saving per category until the gap is covered', () => {
  const db = demoDb();
  const { plan } = rulesPlan(situation(db, report(db)));
  assert.deepEqual(plan.items.map((i) => [i.id, i.savingsCents]), [['food:cut_back:50', 5807], ['fuel:public_transport:3', 4350]]);
  assert.equal(plan.totalCents, 10157);
  assert.equal(plan.afterCents, -3254);
  assert.equal(plan.summary, 'This plan saves $101.57 and brings the month back under budget by $32.54.');
});

test('rules plan avoids plan types the user missed twice', () => {
  const db = demoDb();
  const ins = db.prepare(`INSERT INTO approvals (id, option_id, category, month, description, amount_cents, receiver, status, plan_since, plan_allowance_cents)
    VALUES (?, 'fuel:public_transport:3', 'fuel', ?, 'Public transport instead of driving on 3 days', 3000, 'x', 'completed', ?, 100)`);
  ins.run('h1', '2026-08', '2026-08-05T00:00:00Z'); // $40 of fuel after it, allowance $1: missed
  ins.run('h2', '2026-09', '2026-09-05T00:00:00Z');
  const { plan, trace } = rulesPlan(situation(db, report(db)));
  assert.deepEqual(plan.items.map((i) => i.id), ['food:cut_back:50']);
  assert.match(trace.map((t) => t.text).join(' '), /Skipped public transport days: you missed those plans before/);
  assert.equal(plan.afterCents, 1096);
  assert.match(plan.summary, /leaves you \$10\.96 over budget/);
});

test('the agent gathers facts, simulates, and its plan is checked before it is accepted', async () => {
  const db = demoDb();
  const { turn, seen } = scripted([
    [call('getBudgetStatus'), call('getSpikes'), call('getPlanHistory'), call('getPlanOptions', { category: 'fuel' }), call('getPlanOptions', { category: 'food' })],
    [call('simulate', { optionIds: ['fuel:public_transport:3', 'food:cut_back:25'] }), call('simulate', { optionIds: ['fuel:public_transport:2', 'food:cut_back:50'] })],
    // Invents a figure: rejected and sent back.
    [call('proposePlan', { optionIds: ['fuel:public_transport:2', 'food:cut_back:50'], summary: 'Saves $99.99.', reasons: [{ optionId: 'fuel:public_transport:2', why: 'Fuel is the spike.' }, { optionId: 'food:cut_back:50', why: 'Food has room.' }] })],
    [call('proposePlan', { optionIds: ['fuel:public_transport:2', 'food:cut_back:50'], summary: 'This saves $87.07 and brings you back under by $18.04.', reasons: [{ optionId: 'fuel:public_transport:2', why: 'Fuel is up $192.90, from more purchases.' }, { optionId: 'food:cut_back:50', why: 'Food has the most room.' }] })],
  ]);
  const r = await rescuePlan(db, report(db), { turn, useAI: true });
  assert.equal(r.source, 'ai');
  assert.deepEqual(r.plan.items.map((i) => [i.optionId, i.savingsCents]), [['fuel:public_transport:2', 2900], ['food:cut_back:50', 5807]]);
  assert.equal(r.plan.totalCents, 8707);
  assert.equal(r.plan.afterCents, -1804);
  assert.equal(r.plan.items[0].why, 'Fuel is up $192.90, from more purchases.');

  // The agent saw exact figures from code, and the reason its first proposal was rejected.
  const simulated = seen[2].parts.map((p) => p.functionResponse.response.result);
  assert.deepEqual(simulated, [{ totalSaves: '$72.53', backUnderBudgetBy: '$3.50' }, { totalSaves: '$87.07', backUnderBudgetBy: '$18.04' }]);
  assert.match(seen[3].parts[0].functionResponse.response.errors[0], /"99\.99" is not a figure from the tools/);
  assert.match(r.trace.map((t) => t.text).join('\n'), /Checked the budget: heading \$69\.03 over \$505\.00\.[\s\S]*Tried public transport instead of driving on 2 days \+ spend 50% less on food for the rest of the month: saves \$87\.07, back under by \$18\.04\.[\s\S]*First proposal failed the checks[\s\S]*Proposed the plan below\./);

  // Cached: the same situation never calls the model again.
  const again = await rescuePlan(db, report(db), { turn: async () => assert.fail('model called again'), useAI: true });
  assert.deepEqual(again.plan, r.plan);
});

test('options the tools never offered, or two in one category, are rejected', async () => {
  const db = demoDb();
  setFlexible(db, 'food', false);
  const { turn, seen } = scripted([
    [call('getPlanOptions', { category: 'food' })],
    [call('simulate', { optionIds: ['fuel:public_transport:2', 'fuel:public_transport:3'] }), call('simulate', { optionIds: ['food:cut_back:50'] })],
    [call('proposePlan', { optionIds: ['fuel:public_transport:3'], summary: 'Take transit on 3 days.', reasons: [{ optionId: 'fuel:public_transport:3', why: 'It saves the most.' }] })],
  ]);
  const r = await rescuePlan(db, report(db), { turn, useAI: true });
  assert.equal(seen[1].parts[0].functionResponse.response.result.note, 'The user has not marked this category as flexible. Do not suggest cuts here.');
  const [both, food] = seen[2].parts.map((p) => p.functionResponse.response.result.errors);
  assert.match(both[0], /two options for fuel/);
  assert.match(food[0], /"food:cut_back:50" is not an available option/);
  assert.deepEqual(r.plan.items.map((i) => i.optionId), ['fuel:public_transport:3']);
});

test('when the agent fails, the rules plan is used', async () => {
  const db = demoDb();
  const r = await rescuePlan(db, report(db), { turn: scripted([new Error('503 overloaded')]).turn, useAI: true });
  assert.equal(r.source, 'rules');
  assert.equal(r.aiError, '503 overloaded');
  assert.equal(r.plan.totalCents, 10157);
});

test('the dashboard never waits: rules plan now, agent plan on a later load', async () => {
  const db = demoDb();
  const { turn } = scripted([
    [call('simulate', { optionIds: ['food:cut_back:50', 'fuel:public_transport:3'] })],
    [call('proposePlan', { optionIds: ['food:cut_back:50', 'fuel:public_transport:3'], summary: 'Back under budget by $32.54.', reasons: [{ optionId: 'food:cut_back:50', why: 'Most room.' }, { optionId: 'fuel:public_transport:3', why: 'Fuel is the spike.' }] })],
  ]);
  const first = await rescuePlan(db, report(db), { turn, useAI: true, wait: false });
  assert.equal(first.source, 'rules');
  assert.equal(first.pending, true);
  await rescueIdle();
  const later = await rescuePlan(db, report(db), { turn, useAI: true, wait: false });
  assert.equal(later.source, 'ai');
  assert.equal(later.plan.summary, 'Back under budget by $32.54.');
});

test('approving the rescue plan approves each item; the plan is then covered', async () => {
  const db = demoDb();
  const client = {
    payouts: [],
    async getBalance() { return { availableCents: 500000, refreshedAt: null }; },
    async createPayout(p) { this.payouts.push(p); return { payoutBatchId: `B${this.payouts.length}`, batchStatus: 'PENDING' }; },
  };
  const opts = { client, receiver: 'savings@example.com' };
  const { plan } = await rescuePlan(db, report(db), { useAI: false });
  const items = plan.items.map((i) => ({ optionId: i.optionId, expectedAmountCents: i.savingsCents }));
  // approveRescue approves as of today; pin the approvals to the demo date instead.
  const results = await approveRescue(db, items, opts, ASOF);
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  assert.deepEqual(client.payouts.map((p) => p.amountCents), [5807, 4350]);
  assert.equal((await rescuePlan(db, report(db), { useAI: false })).status, 'covered');

  // Approving again: each category already has its plan, so nothing more moves.
  const repeat = await approveRescue(db, items, opts, ASOF);
  assert.equal(client.payouts.length, 2);
  assert.ok(repeat.every((r) => r.ok && r.approval.status === 'sent'));
});
