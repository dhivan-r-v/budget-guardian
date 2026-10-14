// LLM categorizer: labels uncategorized transactions with a category and a recurring flag.
//
// Transactions are grouped by merchant + description, so the LLM labels each group once
// (the whole seeded history fits in one request, which matters on the free tier's ~5
// requests per minute). Code computes the evidence for "recurring" (months seen, charges
// per month, amount and day-of-month spread); the LLM only judges it. Labels outside the
// fixed category list are ignored. Validated batches are cached, so a reseed with the same
// data costs no quota.
import { createHash } from 'node:crypto';
import { AI_MODEL, aiAvailable, generateJson } from './ai.js';
import { usd } from './advisor.js';

export const CATEGORIES = [
  'bills', 'education', 'entertainment', 'food', 'fuel',
  'health', 'shopping', 'transport', 'travel', 'other',
];

const PROMPT_VERSION = 1;
const BATCH_SIZE = 50;
// A background job, not a page load, so it can wait longer than the advisor.
const TIMEOUT_MS = 60_000;

const range = (lo, hi, fmt = String) => (lo === hi ? fmt(lo) : `${fmt(lo)} to ${fmt(hi)}`);

// Uncategorized transactions grouped by merchant + description, with recurring evidence.
export function pendingGroups(db) {
  const rows = db
    .prepare(`
      SELECT merchant, COALESCE(description, '') AS description, occurred_at, amount_cents
      FROM transactions WHERE category IS NULL ORDER BY occurred_at
    `)
    .all();
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.merchant}\u0000${r.description}`;
    if (!groups.has(key)) groups.set(key, { merchant: r.merchant, description: r.description, rows: [] });
    groups.get(key).rows.push(r);
  }
  return [...groups.values()].map((g) => {
    const amounts = g.rows.map((r) => r.amount_cents);
    const days = g.rows.map((r) => Number(r.occurred_at.slice(8, 10)));
    const months = new Set(g.rows.map((r) => r.occurred_at.slice(0, 7))).size;
    return {
      merchant: g.merchant,
      description: g.description,
      evidence: {
        transactions: g.rows.length,
        monthsSeen: months,
        chargesPerMonth: Math.round((g.rows.length / months) * 10) / 10,
        amount: range(Math.min(...amounts), Math.max(...amounts), usd),
        dayOfMonth: range(Math.min(...days), Math.max(...days)),
      },
    };
  });
}

const SYSTEM = `You label spending transactions for a budgeting app used by students and young professionals.
Each item is one merchant + description, with evidence computed from all of its transactions.

For every item return:
- category: exactly one of ${CATEGORIES.join(', ')}.
    fuel: gas stations. food: groceries, restaurants, food delivery, coffee.
    entertainment: streaming, music, games, movies, concerts, events.
    bills: phone, internet, utilities, insurance, rent, memberships such as gyms.
    shopping: retail and online stores, clothing, electronics. transport: rideshare, transit, parking.
    Use other only when nothing else fits.
- recurring: true only for a subscription or bill charged about once a month at about the same amount.
  Judge it from the evidence (monthsSeen, chargesPerMonth near 1, a single amount, a single day of month),
  not from the merchant name alone. Frequent everyday purchases are not recurring.

Return exactly one entry per item, using the item's id.`;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          recurring: { type: 'boolean' },
        },
        required: ['id', 'category', 'recurring'],
      },
    },
  },
  required: ['items'],
};

// Keeps only well-formed labels for ids that were asked about.
export function validLabels(out, ids) {
  const wanted = new Set(ids);
  const labels = new Map();
  for (const item of Array.isArray(out?.items) ? out.items : []) {
    if (!wanted.has(item?.id) || labels.has(item.id)) continue;
    if (!CATEGORIES.includes(item.category) || typeof item.recurring !== 'boolean') continue;
    labels.set(item.id, { category: item.category, recurring: item.recurring });
  }
  return labels;
}

async function labelBatch(db, batch, generate) {
  const items = batch.map((g, i) => ({ id: `g${i + 1}`, merchant: g.merchant, description: g.description, ...g.evidence }));
  const key = createHash('sha256').update(JSON.stringify({ v: PROMPT_VERSION, model: AI_MODEL, items })).digest('hex');
  const cached = db.prepare('SELECT response FROM ai_cache WHERE key = ?').get(key);
  if (cached) return { labels: new Map(JSON.parse(cached.response)), cached: true };

  const out = await generate({
    system: SYSTEM,
    prompt: `ITEMS:\n${JSON.stringify(items, null, 2)}`,
    schema: SCHEMA,
    timeoutMs: TIMEOUT_MS,
  });
  const labels = validLabels(out, items.map((it) => it.id));
  // Only cache a complete answer, so a partial one is asked again next time.
  if (labels.size === items.length) {
    db.prepare('INSERT OR REPLACE INTO ai_cache (key, model, response) VALUES (?, ?, ?)').run(key, AI_MODEL, JSON.stringify([...labels]));
  }
  return { labels, cached: false };
}

// Labels every uncategorized transaction it can. Never throws on LLM failure: transactions
// it could not label stay NULL (the detector then falls back to seed labels) and are
// retried on the next run. `generate` and `useAI` are injectable for tests.
export async function categorize(db, { generate = generateJson, useAI = aiAvailable(), batchSize = BATCH_SIZE } = {}) {
  const groups = pendingGroups(db);
  const result = { groups: groups.length, labeledGroups: 0, labeledTransactions: 0, requests: 0, cachedBatches: 0, errors: [] };
  if (!groups.length) return result;
  if (!useAI) {
    result.errors.push('no GEMINI_API_KEY');
    return result;
  }

  const update = db.prepare(`
    UPDATE transactions SET category = ?, is_recurring = ?
    WHERE merchant = ? AND COALESCE(description, '') = ? AND category IS NULL
  `);
  for (let i = 0; i < groups.length; i += batchSize) {
    const batch = groups.slice(i, i + batchSize);
    let labels;
    try {
      const r = await labelBatch(db, batch, generate);
      labels = r.labels;
      if (r.cached) result.cachedBatches++;
      else result.requests++;
    } catch (err) {
      result.requests++;
      result.errors.push(err.message);
      break; // overloaded or out of quota: later batches would fail the same way
    }
    db.exec('BEGIN');
    try {
      batch.forEach((g, j) => {
        const label = labels.get(`g${j + 1}`);
        if (!label) return;
        const { changes } = update.run(label.category, label.recurring ? 1 : 0, g.merchant, g.description);
        result.labeledGroups++;
        result.labeledTransactions += Number(changes);
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return result;
}

// Fallback for real PayPal transactions when the LLM can't label them (no key, overloaded):
// obvious merchant names only, so a sandbox purchase at "Shell" still counts toward fuel.
// Anything unmatched stays unlabeled for the LLM's next run. Never recurring.
const RULES = [
  ['fuel', /\b(shell|chevron|exxon|mobil|bp|texaco|valero|sunoco|citgo|arco|marathon|speedway|gas station|fuel|petrol)\b/i],
  ['entertainment', /\b(netflix|spotify|hulu|disney|youtube|steam|xbox|playstation|nintendo|cinema|theat(er|re)s?|amc|ticketmaster|concert)\b/i],
  ['food', /\b(starbucks|dunkin|coffee|cafe|restaurant|pizza|domino'?s|chipotle|mcdonald'?s|subway|doordash|uber ?eats|grubhub|grocer(y|ies)|trader joe'?s|kroger|aldi|whole foods)\b/i],
  ['transport', /\b(uber|lyft|metro|transit|parking|train|bus)\b/i],
  ['shopping', /\b(amazon|target|walmart|best ?buy|ebay|etsy|ikea|h&m|zara)\b/i],
];
export function ruleLabel(merchant, description = '') {
  const text = `${merchant} ${description ?? ''}`;
  return RULES.find(([, re]) => re.test(text))?.[0] ?? null;
}

export function labelPayPalByRules(db) {
  const rows = db
    .prepare(`
      SELECT merchant, COALESCE(description, '') AS description FROM transactions
      WHERE source = 'paypal' AND category IS NULL GROUP BY merchant, COALESCE(description, '')
    `)
    .all();
  const update = db.prepare(`
    UPDATE transactions SET category = ?, is_recurring = 0
    WHERE source = 'paypal' AND category IS NULL AND merchant = ? AND COALESCE(description, '') = ?
  `);
  let labeled = 0;
  for (const r of rows) {
    const category = ruleLabel(r.merchant, r.description);
    if (category) labeled += Number(update.run(category, r.merchant, r.description).changes);
  }
  return labeled;
}

// How well the LLM labels match the seed's ground truth (seed transactions only).
export function accuracy(db) {
  const row = db
    .prepare(`
      SELECT COUNT(*) AS labeled,
             SUM(category = seed_category) AS categoryCorrect,
             SUM(is_recurring = seed_recurring) AS recurringCorrect
      FROM transactions WHERE source = 'seed' AND category IS NOT NULL
    `)
    .get();
  const mismatches = db
    .prepare(`
      SELECT merchant, description, category, seed_category AS expected, is_recurring AS recurring,
             seed_recurring AS expectedRecurring, COUNT(*) AS transactions
      FROM transactions
      WHERE source = 'seed' AND category IS NOT NULL
        AND (category IS NOT seed_category OR is_recurring IS NOT seed_recurring)
      GROUP BY merchant, description, category, is_recurring
      ORDER BY transactions DESC
    `)
    .all();
  const pct = (n) => (row.labeled ? Math.round((n / row.labeled) * 1000) / 10 : null);
  return {
    labeled: row.labeled,
    categoryAccuracyPct: pct(row.categoryCorrect ?? 0),
    recurringAccuracyPct: pct(row.recurringCorrect ?? 0),
    mismatches,
  };
}

// Clears LLM labels so the next categorize() run labels everything again.
export function resetLabels(db) {
  return Number(db.prepare('UPDATE transactions SET category = NULL, is_recurring = NULL').run().changes);
}
