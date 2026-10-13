import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { categorize, pendingGroups, validLabels, accuracy, resetLabels } from '../src/categorizer.js';

let seq = 0;
function dbWith(txns) {
  const db = openDb(':memory:');
  const insert = db.prepare(`
    INSERT INTO transactions (id, occurred_at, amount_cents, merchant, description, source, seed_category, seed_recurring)
    VALUES (?, ?, ?, ?, ?, 'seed', ?, ?)
  `);
  for (const [date, cents, merchant, description, cat, recurring] of txns) {
    insert.run(`t${++seq}`, `${date}T12:00:00Z`, cents, merchant, description, cat, recurring);
  }
  return db;
}

// Netflix monthly on the 3rd; Shell several times a month at varying amounts.
const history = () => [
  ['2026-08-03', 1549, 'Netflix', 'Netflix Standard plan', 'entertainment', 1],
  ['2026-09-03', 1549, 'Netflix', 'Netflix Standard plan', 'entertainment', 1],
  ['2026-10-03', 1549, 'Netflix', 'Netflix Standard plan', 'entertainment', 1],
  ['2026-08-05', 4210, 'Shell', 'Fuel purchase', 'fuel', 0],
  ['2026-08-19', 3890, 'Shell', 'Fuel purchase', 'fuel', 0],
  ['2026-09-11', 4475, 'Shell', 'Fuel purchase', 'fuel', 0],
];

// A fake LLM that labels items by merchant name and counts calls.
function fakeLabeler(byMerchant) {
  const fn = async ({ prompt }) => {
    fn.calls++;
    const items = JSON.parse(prompt.slice(prompt.indexOf('['), prompt.lastIndexOf(']') + 1));
    return { items: items.map((it) => ({ id: it.id, ...byMerchant[it.merchant] })) };
  };
  fn.calls = 0;
  return fn;
}
const correct = {
  Netflix: { category: 'entertainment', recurring: true },
  Shell: { category: 'fuel', recurring: false },
};

test('groups transactions by merchant and computes recurring evidence', () => {
  const groups = pendingGroups(dbWith(history()));
  assert.deepEqual(
    groups.map((g) => [g.merchant, g.evidence]),
    [
      ['Netflix', { transactions: 3, monthsSeen: 3, chargesPerMonth: 1, amount: '$15.49', dayOfMonth: '3' }],
      ['Shell', { transactions: 3, monthsSeen: 2, chargesPerMonth: 1.5, amount: '$38.90 to $44.75', dayOfMonth: '5 to 19' }],
    ],
  );
});

test('one request labels every transaction in every group', async () => {
  const db = dbWith(history());
  const generate = fakeLabeler(correct);
  const r = await categorize(db, { useAI: true, generate });
  assert.equal(generate.calls, 1);
  assert.equal(r.labeledGroups, 2);
  assert.equal(r.labeledTransactions, 6);
  const rows = db.prepare('SELECT merchant, category, is_recurring FROM transactions GROUP BY merchant').all();
  assert.deepEqual(rows.map((x) => [x.merchant, x.category, x.is_recurring]), [['Netflix', 'entertainment', 1], ['Shell', 'fuel', 0]]);
  assert.deepEqual(pendingGroups(db), []);
});

test('labels outside the category list, or for unknown ids, are ignored', () => {
  const labels = validLabels(
    {
      items: [
        { id: 'g1', category: 'fuel', recurring: false },
        { id: 'g2', category: 'luxury', recurring: false },
        { id: 'g3', category: 'food', recurring: 'yes' },
        { id: 'g9', category: 'food', recurring: false },
        { id: 'g1', category: 'food', recurring: false }, // duplicate: first wins
      ],
    },
    ['g1', 'g2', 'g3'],
  );
  assert.deepEqual([...labels], [['g1', { category: 'fuel', recurring: false }]]);
});

test('a group the LLM did not label stays uncategorized and is retried next run', async () => {
  const db = dbWith(history());
  await categorize(db, { useAI: true, generate: fakeLabeler({ ...correct, Shell: { category: 'gasoline', recurring: false } }) });
  assert.deepEqual(pendingGroups(db).map((g) => g.merchant), ['Shell']);

  const r = await categorize(db, { useAI: true, generate: fakeLabeler(correct) });
  assert.equal(r.labeledTransactions, 3);
  assert.deepEqual(pendingGroups(db), []);
});

test('an API error leaves transactions uncategorized without throwing', async () => {
  const db = dbWith(history());
  const r = await categorize(db, { useAI: true, generate: async () => { throw new Error('503 high demand'); } });
  assert.deepEqual(r.errors, ['503 high demand']);
  assert.equal(pendingGroups(db).length, 2);
});

test('without an API key nothing is sent', async () => {
  const db = dbWith(history());
  const generate = fakeLabeler(correct);
  const r = await categorize(db, { useAI: false, generate });
  assert.equal(generate.calls, 0);
  assert.deepEqual(r.errors, ['no GEMINI_API_KEY']);
});

test('after a reset, the same data is labeled from the cache without a request', async () => {
  const db = dbWith(history());
  const generate = fakeLabeler(correct);
  await categorize(db, { useAI: true, generate });
  assert.equal(resetLabels(db), 6);
  const r = await categorize(db, { useAI: true, generate });
  assert.equal(generate.calls, 1);
  assert.equal(r.cachedBatches, 1);
  assert.equal(r.labeledTransactions, 6);
});

test('large histories are split into batches', async () => {
  const txns = Array.from({ length: 5 }, (_, i) => ['2026-09-01', 1000, `Shop ${i}`, 'Order', 'shopping', 0]);
  const generate = fakeLabeler(Object.fromEntries(txns.map(([, , m]) => [m, { category: 'shopping', recurring: false }])));
  const r = await categorize(dbWith(txns), { useAI: true, generate, batchSize: 2 });
  assert.equal(generate.calls, 3);
  assert.equal(r.labeledTransactions, 5);
});

test('accuracy compares LLM labels with the seed ground truth', async () => {
  const db = dbWith(history());
  await categorize(db, { useAI: true, generate: fakeLabeler({ ...correct, Netflix: { category: 'entertainment', recurring: false } }) });
  const a = accuracy(db);
  assert.equal(a.labeled, 6);
  assert.equal(a.categoryAccuracyPct, 100);
  assert.equal(a.recurringAccuracyPct, 50);
  assert.deepEqual(a.mismatches.map((m) => [m.merchant, m.recurring, m.expectedRecurring, m.transactions]), [['Netflix', 0, 1, 3]]);
});
