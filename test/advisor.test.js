import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';
import { setFlexible } from '../src/savings.js';
import { adviseCategory, adviseSpikes, templateAdvice, validateAdvice, usd } from '../src/advisor.js';

let seq = 0;
function fuelSpikeDb() {
  const db = openDb(':memory:');
  const insert = db.prepare(`
    INSERT INTO transactions (id, occurred_at, amount_cents, merchant, source, seed_category, seed_recurring)
    VALUES (?, ?, ?, 'Shell', 'seed', ?, 0)
  `);
  for (const m of ['2026-07', '2026-08', '2026-09']) {
    for (const d of ['03', '10', '17', '24']) insert.run(`t${++seq}`, `${m}-${d}T12:00:00Z`, 4000, 'fuel');
  }
  for (const d of ['01', '03', '06', '09', '12']) insert.run(`t${++seq}`, `2026-10-${d}T12:00:00Z`, 5200, 'fuel');
  setFlexible(db, 'fuel', true);
  return db;
}

function setup() {
  const db = fuelSpikeDb();
  const report = detectSpikes(db, { asOf: '2026-10-13' });
  return { db, report, entry: report.spikes[0] };
}

// A fake LLM that returns the given responses in order and counts calls.
function fakeGenerate(...responses) {
  const fn = async () => {
    fn.calls++;
    const r = responses[Math.min(fn.calls - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = 0;
  return fn;
}

// A response that only uses figures from the facts.
function goodResponse(facts) {
  return {
    headline: `Fuel is ${facts.projectedFullMonthVsUsualPercent} above usual`,
    explanation: `You've spent ${facts.spentSoFarThisMonth} by ${facts.day}, heading for ${facts.projectedFullMonth}.`,
    options: facts.options.map((o) => ({ id: o.id, text: `Ride transit ${o.days} days and save ${o.saves}, avoiding ${o.co2Avoided}.` })),
  };
}

test('facts are pre-formatted by code', async () => {
  const { db, report, entry } = setup();
  const { facts } = await adviseCategory(db, report, entry, { useAI: false });
  assert.equal(facts.usualFullMonth, '$160.00');
  assert.equal(facts.spentSoFarThisMonth, '$260.00');
  assert.equal(facts.projectedFullMonth, '$352.90'); // 260 + 160 x 18/31
  assert.equal(facts.projectedFullMonthVsUsual, '$192.90 above usual');
  assert.equal(facts.projectedFullMonthVsUsualPercent, '121%');
  assert.equal(facts.cause.main, 'more purchases than usual');
  assert.deepEqual(facts.options.map((o) => o.id), ['fuel:public_transport:2', 'fuel:public_transport:3']);
});

test('without an API key, code-written text is used and the LLM is never called', async () => {
  const { db, report, entry } = setup();
  const generate = fakeGenerate({});
  const { advice } = await adviseCategory(db, report, entry, { useAI: false, generate });
  assert.equal(generate.calls, 0);
  assert.equal(advice.source, 'template');
  assert.match(advice.headline, /Fuel spending is 121% above usual/);
  assert.match(advice.explanation, /5 so far, when about 1\.7 would be usual/); // 4 x 13/31
});

test('the template passes its own number check', async () => {
  const { db, report, entry } = setup();
  const { facts, cause } = await adviseCategory(db, report, entry, { useAI: false });
  assert.deepEqual(validateAdvice(templateAdvice(facts, cause.primaryCause), facts), []);
});

test('a valid LLM response is used and cached', async () => {
  const { db, report, entry } = setup();
  const { facts } = await adviseCategory(db, report, entry, { useAI: false });
  const generate = fakeGenerate(goodResponse(facts));

  const first = await adviseCategory(db, report, entry, { useAI: true, generate });
  assert.equal(first.advice.source, 'ai');
  assert.equal(first.advice.cached, false);
  assert.equal(first.advice.headline, 'Fuel is 121% above usual');

  const second = await adviseCategory(db, report, entry, { useAI: true, generate });
  assert.equal(second.advice.cached, true);
  assert.equal(generate.calls, 1);
});

test('an invented or rounded number is rejected, and the template is used after retries', async () => {
  const { db, report, entry } = setup();
  const { facts } = await adviseCategory(db, report, entry, { useAI: false });
  const rounded = { ...goodResponse(facts), explanation: 'You could end the month around $353.' };
  const generate = fakeGenerate(rounded);

  const { advice } = await adviseCategory(db, report, entry, { useAI: true, generate });
  assert.equal(generate.calls, 2);
  assert.equal(advice.source, 'template');
  assert.match(advice.aiError, /number "353" is not in the facts/);
});

test('a bad first answer is retried, and a good second answer is used', async () => {
  const { db, report, entry } = setup();
  const { facts } = await adviseCategory(db, report, entry, { useAI: true, generate: fakeGenerate(new Error('x')) });
  const bad = { ...goodResponse(facts), headline: 'Fuel is up 200%' };
  const generate = fakeGenerate(bad, goodResponse(facts));
  const { advice } = await adviseCategory(db, report, entry, { useAI: true, generate });
  assert.equal(generate.calls, 2);
  assert.equal(advice.source, 'ai');
});

test('missing or made-up option ids are rejected', async () => {
  const { db, report, entry } = setup();
  const { facts } = await adviseCategory(db, report, entry, { useAI: false });
  const good = goodResponse(facts);
  assert.match(validateAdvice({ ...good, options: good.options.slice(1) }, facts).join(), /option ids/);
  assert.match(
    validateAdvice({ ...good, options: [...good.options, { id: 'fuel:sell_car', text: 'Sell the car.' }] }, facts).join(),
    /option ids/,
  );
});

test('an API error falls back to the template', async () => {
  const { db, report, entry } = setup();
  const { advice } = await adviseCategory(db, report, entry, { useAI: true, generate: fakeGenerate(new Error('429 quota exceeded')) });
  assert.equal(advice.source, 'template');
  assert.match(advice.aiError, /429/);
});

test('amounts over $1,000 keep their thousands separator and still validate', () => {
  assert.equal(usd(123456), '$1,234.56');
  const facts = { options: [], spentSoFarThisMonth: usd(123456) };
  assert.deepEqual(validateAdvice({ headline: 'Spent $1,234.56', explanation: 'Yes.', options: [] }, facts), []);
});

test('adviseSpikes adds cause, savings and advice to every spike', async () => {
  const { db, report } = setup();
  const result = await adviseSpikes(db, report, { useAI: false });
  const [fuel] = result.spikes;
  assert.equal(fuel.category, 'fuel');
  assert.equal(fuel.cause.primaryCause, 'more_often');
  assert.equal(fuel.savings.options.length, 2);
  assert.equal(fuel.advice.options.length, 2);
});
