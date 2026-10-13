// Turns the computed spike, cause and savings numbers into friendly text.
//
// Code formats every figure; the LLM only writes sentences around them. Every number in
// the LLM's text must appear verbatim in the facts it was given, otherwise the response is
// rejected and a code-written template is used instead. The app therefore works without
// an API key, and the LLM can never introduce a wrong amount.
import { createHash } from 'node:crypto';
import { AI_MODEL, aiAvailable, generateJson } from './ai.js';
import { explainSpike } from './causes.js';
import { suggestSavings } from './savings.js';

const PROMPT_VERSION = 2;
const MAX_ATTEMPTS = 2;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export const usd = (cents) =>
  `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const CAUSE_TEXT = {
  more_often: 'more purchases than usual',
  higher_prices: 'purchases costing more than usual',
  large_purchase: 'one unusually large purchase',
  new_subscription: 'a new subscription',
  subscription_price_increase: 'a subscription price increase',
};

function causeFacts(cause) {
  const o = cause.oneOff;
  return {
    main: CAUSE_TEXT[cause.primaryCause],
    purchasesSoFar: o.count,
    usualPurchasesByToday: o.expectedCount,
    usualPurchasesPerMonth: o.usualMonthlyCount,
    averagePurchase: usd(o.averageAmountCents),
    usualPurchase: usd(o.usualAmountCents),
    increaseFromMorePurchases: usd(o.moreOftenCents),
    increaseFromHigherPrices: usd(o.higherPricesCents),
    newSubscriptions: cause.recurring.newSubscriptions.map((t) => `${t.merchant} ${usd(t.amountCents)}`),
    subscriptionPriceIncreases: cause.recurring.priceIncreases.map(
      (t) => `${t.merchant} ${usd(t.usualAmountCents)} to ${usd(t.amountCents)}`,
    ),
    largePurchases: cause.largePurchases.map((t) => `${t.merchant} ${usd(t.amountCents)}`),
  };
}

function optionFacts(category, o) {
  switch (o.type) {
    case 'public_transport':
      return {
        id: o.id,
        action: `Use public transport instead of driving on ${o.transitDays} days`,
        days: o.transitDays,
        saves: usd(o.savingsCents),
        fuelAvoided: usd(o.fuelAvoidedCents),
        fares: usd(o.transitCostCents),
        co2Avoided: `${o.co2AvoidedKg} kg CO2`,
      };
    case 'skip_subscriptions':
      return {
        id: o.id,
        action: 'Skip subscriptions that have not been billed yet this month',
        saves: usd(o.savingsCents),
        notBilledYet: o.subscriptions.filter((s) => !s.chargedThisMonth).map((s) => `${s.merchant} ${usd(s.amountCents)}`),
        alreadyBilled: o.subscriptions.filter((s) => s.chargedThisMonth).map((s) => s.merchant),
      };
    default:
      return {
        id: o.id,
        action: `Spend ${o.percent}% less on one-off ${category} purchases for the rest of the month`,
        saves: usd(o.savingsCents),
      };
  }
}

export function buildFacts(report, entry, cause, savings) {
  const [y, m] = report.month.split('-').map(Number);
  const above = entry.increaseCents >= 0;
  return {
    category: entry.category,
    month: `${MONTHS[m - 1]} ${y}`,
    day: `day ${report.daysElapsed} of ${report.daysInMonth}`,
    status: entry.isSpike ? 'spike' : above ? 'a little above usual' : 'at or below usual',
    usualFullMonth: usd(entry.baselineAvgCents),
    spentSoFarThisMonth: usd(entry.currentCents),
    projectedFullMonth: usd(entry.projectedCents),
    projectedFullMonthVsUsual: `${usd(Math.abs(entry.increaseCents))} ${above ? 'above' : 'below'} usual`,
    projectedFullMonthVsUsualPercent: entry.increasePct === null ? null : `${Math.round(Math.abs(entry.increasePct))}%`,
    cause: entry.isSpike && cause ? causeFacts(cause) : null,
    options: savings.options.map((o) => optionFacts(entry.category, o)),
  };
}

// --- Validation: the LLM may only repeat numbers it was given.

const numbersIn = (text) => (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));

export function validateAdvice(out, facts) {
  const errors = [];
  if (typeof out?.headline !== 'string' || !out.headline.trim()) errors.push('missing headline');
  if (typeof out?.explanation !== 'string' || !out.explanation.trim()) errors.push('missing explanation');
  const expectedIds = facts.options.map((o) => o.id).sort();
  const gotIds = Array.isArray(out?.options) ? out.options.map((o) => o?.id).sort() : [];
  if (JSON.stringify(expectedIds) !== JSON.stringify(gotIds)) errors.push('options do not match the given option ids');
  if (errors.length) return errors;

  const allowed = new Set(numbersIn(JSON.stringify(facts)));
  const texts = [out.headline, out.explanation, ...out.options.map((o) => String(o.text ?? ''))];
  for (const text of texts) {
    for (const n of numbersIn(text)) if (!allowed.has(n)) errors.push(`number "${n}" is not in the facts`);
  }
  if (out.options.some((o) => typeof o.text !== 'string' || !o.text.trim())) errors.push('empty option text');
  return errors;
}

// --- Template: code-written text, used without an API key or when the LLM fails validation.

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

export function templateAdvice(facts, primaryCause) {
  const { category: cat, cause: c } = facts;
  const headline =
    facts.status === 'spike'
      ? `${cap(cat)} spending is ${facts.projectedFullMonthVsUsualPercent ?? facts.projectedFullMonthVsUsual} above usual this month`
      : `${cap(cat)} spending is ${facts.status} this month`;

  let explanation = `By ${facts.day} you've spent ${facts.spentSoFarThisMonth} on ${cat}. `;
  if (facts.status === 'spike') {
    explanation += `Even if you spend normally from today, you'd end ${facts.month} at about ${facts.projectedFullMonth}, ${facts.projectedFullMonthVsUsual} (usual: ${facts.usualFullMonth}).`;
    const reason = {
      more_often: `The main reason is more purchases: ${c?.purchasesSoFar} so far, when about ${c?.usualPurchasesByToday} would be usual by now.`,
      higher_prices: `The main reason is higher prices: ${c?.averagePurchase} per purchase on average, against a usual ${c?.usualPurchase}.`,
      large_purchase: `The main reason is one large purchase: ${c?.largePurchases?.[0]}.`,
      new_subscription: `The main reason is a new subscription: ${list(c?.newSubscriptions ?? [])}.`,
      subscription_price_increase: `The main reason is a subscription price increase: ${list(c?.subscriptionPriceIncreases ?? [])}.`,
    }[primaryCause];
    if (c && reason) explanation += ` ${reason}`;
  } else {
    explanation += `At a normal pace you'd end ${facts.month} at about ${facts.projectedFullMonth} (usual: ${facts.usualFullMonth}).`;
  }

  const options = facts.options.map((o) => {
    if (o.days !== undefined) {
      return { id: o.id, text: `Take public transport instead of driving on ${o.days} days: save ${o.saves} after ${o.fares} in fares, and avoid ${o.co2Avoided}.` };
    }
    if (o.notBilledYet !== undefined) {
      return {
        id: o.id,
        text: o.notBilledYet.length
          ? `Skip ${list(o.notBilledYet)} before they bill this month: save ${o.saves}.`
          : 'All your subscriptions have already been billed this month, so skipping now would only save next month.',
      };
    }
    return { id: o.id, text: `${o.action}: save ${o.saves}.` };
  });
  return { headline, explanation, options };
}

// --- LLM call

const SYSTEM = `You are Budget Guardian, a friendly money assistant for students and young professionals on a fixed monthly income.
You receive FACTS about one spending category this month and write short, warm, plain-English text.

Rules:
- Use only the figures in FACTS, copied exactly as written (e.g. "$179.10", "145.1 kg CO2"). Never calculate, round, add, convert or invent any number.
- Each figure means exactly what its name says. spentSoFarThisMonth is spending to date. projectedFullMonthVsUsual compares the projected full-month total with a usual full month; never present it as the difference between spending so far and usual.
- For public transport options, mention both the money saved and the CO2 avoided.
- Do not judge the user or label any purchase as a need or a want.
- Nothing has happened yet: present options as choices the user can approve, never as actions already taken.
- headline: one line, at most 80 characters.
- explanation: 2-3 sentences. Say what changed and the main reason, using the cause facts when present.
- options: exactly one entry per option in FACTS, with the same id, and one sentence each that states what the user would do and what they would save.`;

const SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    explanation: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
      },
    },
  },
  required: ['headline', 'explanation', 'options'],
};

// Advice for one category entry from detectSpikes(). `generate` and `useAI` are injectable for tests.
export async function adviseCategory(db, report, entry, { generate = generateJson, useAI = aiAvailable() } = {}) {
  const cause = entry.isSpike ? explainSpike(db, report, entry) : null;
  const savings = suggestSavings(db, report, entry);
  const facts = buildFacts(report, entry, cause, savings);
  const base = { category: entry.category, cause, savings, facts };
  const fallback = templateAdvice(facts, cause?.primaryCause);
  if (!useAI) return { ...base, advice: { ...fallback, source: 'template' } };

  const key = createHash('sha256').update(JSON.stringify({ v: PROMPT_VERSION, model: AI_MODEL, facts })).digest('hex');
  const cached = db.prepare('SELECT response FROM ai_cache WHERE key = ?').get(key);
  if (cached) return { ...base, advice: { ...JSON.parse(cached.response), source: 'ai', model: AI_MODEL, cached: true } };

  let lastError;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const out = await generate({ system: SYSTEM, prompt: `FACTS:\n${JSON.stringify(facts, null, 2)}`, schema: SCHEMA });
      const errors = validateAdvice(out, facts);
      if (errors.length) {
        lastError = errors.join('; ');
        continue;
      }
      // Keep only the expected fields, with options in the same order as the facts.
      const textById = new Map(out.options.map((o) => [o.id, o.text.trim()]));
      const advice = {
        headline: out.headline.trim(),
        explanation: out.explanation.trim(),
        options: facts.options.map((o) => ({ id: o.id, text: textById.get(o.id) })),
      };
      db.prepare('INSERT OR REPLACE INTO ai_cache (key, model, response) VALUES (?, ?, ?)').run(key, AI_MODEL, JSON.stringify(advice));
      return { ...base, advice: { ...advice, source: 'ai', model: AI_MODEL, cached: false } };
    } catch (err) {
      // API errors (overloaded, quota) won't clear up within a request; retrying only burns quota.
      lastError = err.message;
      break;
    }
  }
  return { ...base, advice: { ...fallback, source: 'template', aiError: lastError } };
}

// Advice for every spike in a detectSpikes() report.
export async function adviseSpikes(db, report, opts) {
  const spikes = [];
  for (const entry of report.spikes) spikes.push({ ...entry, ...(await adviseCategory(db, report, entry, opts)) });
  return { ...report, spikes };
}
