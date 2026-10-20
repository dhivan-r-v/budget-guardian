// Rescue plan: when the month is heading over budget, an AI agent plans how to get back.
//
// The agent gets a goal (the overspend still to cover) and read-only tools that return
// exact figures computed by code: the budget, the spikes and their causes, recent
// purchases, the savings options per category, and which past plans the user kept or
// missed. It decides which options to combine, checks them with simulate(), and finishes by
// calling proposePlan(). Code then checks the proposal: only options the tools offered, at
// most one per category, and no number in its text that a tool didn't return. A rejected
// proposal goes back to the agent with the reasons, so it can fix it.
//
// The agent never moves money. Its plan is a proposal the user approves, and each item is
// then approved through approvals.js like any other plan. Without an API key, or when the
// agent fails, a rules-based planner (largest savings first, skipping plan types the user
// keeps missing) proposes the plan instead.
import { createHash } from 'node:crypto';
import { AI_MODEL, aiAvailable, chatTurn } from './ai.js';
import { explainSpike } from './causes.js';
import { suggestSavings, isFlexible } from './savings.js';
import { budgetStatus } from './budget.js';
import { usd } from './advisor.js';
import { approve, listApprovals, followThrough, describe, ApprovalError } from './approvals.js';

const PROMPT_VERSION = 1;
const MAX_TURNS = 8;
const MISSED_LIMIT = 2; // plan types missed this many times are avoided

const CAUSE_TEXT = {
  more_often: 'more purchases than usual',
  higher_prices: 'each purchase costing more than usual',
  large_purchase: 'one unusually large purchase',
  new_subscription: 'a new subscription',
  subscription_price_increase: 'a subscription price increase',
};
const TYPE_TEXT = { public_transport: 'public transport days', skip_subscriptions: 'skipping subscriptions', cut_back: 'cutting back' };
const optionType = (optionId) => optionId.split(':')[1];
// 'Skip Disney+ this month' -> 'skip Disney+ this month' (keeps merchant names as written).
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

// --- The situation, computed once by code. Everything the tools return comes from here.

export function situation(db, report) {
  const budget = budgetStatus(db, report);
  const approvals = listApprovals(db).filter((a) => a.status !== 'failed');
  const live = approvals.filter((a) => a.month === report.month);
  const committedCents = live.reduce((s, a) => s + a.amountCents, 0);
  const planned = new Set(live.map((a) => a.category));

  const categories = report.categories.map((entry) => ({ entry, flexible: isFlexible(db, entry.category), planned: planned.has(entry.category) }));
  const options = new Map();
  for (const c of categories) {
    if (!c.flexible || c.planned) continue;
    for (const o of suggestSavings(db, report, c.entry).options) {
      if (o.savingsCents > 0) options.set(o.id, { id: o.id, category: c.entry.category, type: o.type, savingsCents: o.savingsCents, description: describe(c.entry.category, o), co2AvoidedKg: o.co2AvoidedKg ?? null });
    }
  }
  const history = approvals.map((a) => ({
    category: a.category,
    month: a.month,
    type: optionType(a.optionId),
    description: a.description,
    result: followThrough(db, a, { asOf: report.asOf })?.status ?? 'not tracked',
  }));
  const overCents = budget.set ? budget.projectedVsBudgetCents : null;
  return { db, report, budget, live, committedCents, categories, options, history, overCents, gapCents: overCents === null ? null : overCents - committedCents };
}

const missedTypes = (sit) => {
  const counts = {};
  for (const h of sit.history) if (h.result === 'missed' || h.result === 'over') counts[h.type] = (counts[h.type] ?? 0) + 1;
  return new Set(Object.keys(counts).filter((t) => counts[t] >= MISSED_LIMIT));
};

// Total of a set of options, and what's left of the gap after them. Errors for unknown
// options or two options in one category (they're alternatives).
function simulate(sit, optionIds) {
  const errors = [];
  const chosen = [];
  const seen = new Set();
  for (const id of optionIds ?? []) {
    const o = sit.options.get(id);
    if (!o) errors.push(`"${id}" is not an available option; use ids from getPlanOptions`);
    else if (seen.has(o.category)) errors.push(`two options for ${o.category}; they are alternatives, choose one`);
    else {
      seen.add(o.category);
      chosen.push(o);
    }
  }
  if (!chosen.length && !errors.length) errors.push('choose at least one option');
  const totalCents = chosen.reduce((s, o) => s + o.savingsCents, 0);
  return { errors, chosen, totalCents, afterCents: sit.gapCents - totalCents };
}

const afterText = (afterCents) => (afterCents > 0 ? { stillOverBudgetBy: usd(afterCents) } : { backUnderBudgetBy: usd(-afterCents) });

// --- Tools: what the agent can see. Each returns figures formatted by code, and a
// one-line description of the step for the "How I planned this" trace.

const TOOLS = [
  { name: 'getBudgetStatus', description: 'The monthly budget, spending so far, the projected month, how far over budget it is, what approved plans already cover, and which categories the user marked as flexible.', parametersJsonSchema: { type: 'object', properties: {} } },
  { name: 'getSpikes', description: 'Categories heading well above their usual month, by how much, and the main cause.', parametersJsonSchema: { type: 'object', properties: {} } },
  {
    name: 'getTransactions',
    description: 'Recent purchases in one category (up to 15), newest first.',
    parametersJsonSchema: { type: 'object', properties: { category: { type: 'string' }, days: { type: 'integer', description: '1-31, default 14' } }, required: ['category'] },
  },
  {
    name: 'getPlanOptions',
    description: 'The savings options for one category with their exact savings. Only flexible categories without an approved plan this month have options.',
    parametersJsonSchema: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] },
  },
  { name: 'getPlanHistory', description: 'Plans the user approved before and whether they kept them (kept, missed, on_track, over).', parametersJsonSchema: { type: 'object', properties: {} } },
  {
    name: 'simulate',
    description: 'Checks a combination of option ids: total saved and how far over (or under) budget the month would end.',
    parametersJsonSchema: { type: 'object', properties: { optionIds: { type: 'array', items: { type: 'string' } } }, required: ['optionIds'] },
  },
  {
    name: 'proposePlan',
    description: 'Finish: propose the plan to the user. Call once, after simulate.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        optionIds: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string', description: '1-2 sentences for the user' },
        reasons: {
          type: 'array',
          items: { type: 'object', properties: { optionId: { type: 'string' }, why: { type: 'string', description: 'one short sentence' } }, required: ['optionId', 'why'] },
        },
      },
      required: ['optionIds', 'summary', 'reasons'],
    },
  },
];

function runTool(sit, name, args) {
  const { report, budget } = sit;
  const cat = (c) => sit.categories.find((x) => x.entry.category === String(c ?? '').toLowerCase());
  switch (name) {
    case 'getBudgetStatus': {
      const out = {
        monthlyBudget: usd(budget.budgetCents),
        spentSoFar: usd(budget.spentCents),
        projectedMonth: usd(budget.projectedCents),
        projectedOverBudgetBy: usd(sit.overCents),
        alreadyCoveredByApprovedPlans: usd(sit.committedCents),
        stillToCover: usd(Math.max(0, sit.gapCents)),
        daysLeft: budget.daysLeft,
        flexibleCategories: sit.categories.filter((c) => c.flexible && !c.planned).map((c) => c.entry.category),
        notFlexibleCategories: sit.categories.filter((c) => !c.flexible).map((c) => c.entry.category),
        categoriesWithApprovedPlan: sit.categories.filter((c) => c.planned).map((c) => c.entry.category),
      };
      return { out, step: `Checked the budget: heading ${out.projectedOverBudgetBy} over ${out.monthlyBudget}${sit.committedCents ? `, ${out.alreadyCoveredByApprovedPlans} already covered` : ''}.` };
    }
    case 'getSpikes': {
      const out = report.spikes.map((s) => {
        const cause = explainSpike(sit.db, report, s);
        return { category: s.category, usualMonth: usd(s.baselineAvgCents), projectedMonth: usd(s.projectedCents), aboveUsual: usd(s.increaseCents), mainCause: CAUSE_TEXT[cause.primaryCause] ?? 'mixed' };
      });
      return { out, step: out.length ? `Looked at the spikes: ${out.map((s) => `${s.category} +${s.aboveUsual} (${s.mainCause})`).join('; ')}.` : 'Looked at the spikes: none.' };
    }
    case 'getTransactions': {
      const c = cat(args.category);
      if (!c) return { out: { error: `unknown category "${args.category}"` }, step: `Asked for purchases in an unknown category "${args.category}".` };
      const days = Math.min(31, Math.max(1, Number.parseInt(args.days, 10) || 14));
      const from = new Date(Date.parse(`${report.asOf}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      const to = new Date(Date.parse(`${report.asOf}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      const rows = sit.db.prepare(`
        SELECT occurred_at, merchant, amount_cents, COALESCE(is_recurring, seed_recurring, 0) AS recurring FROM transactions
        WHERE COALESCE(category, seed_category) = ? AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at DESC LIMIT 15
      `).all(c.entry.category, from, to);
      const out = rows.map((r) => ({ date: r.occurred_at.slice(0, 10), merchant: r.merchant, amount: usd(r.amount_cents), recurring: Boolean(r.recurring) }));
      return { out, step: `Read ${out.length} recent ${c.entry.category} purchase${out.length === 1 ? '' : 's'} (last ${days} days).` };
    }
    case 'getPlanOptions': {
      const c = cat(args.category);
      if (!c) return { out: { error: `unknown category "${args.category}"` }, step: `Asked for plans in an unknown category "${args.category}".` };
      const name = c.entry.category;
      if (!c.flexible) return { out: { category: name, options: [], note: 'The user has not marked this category as flexible. Do not suggest cuts here.' }, step: `Skipped ${name}: you haven't marked it as flexible.` };
      if (c.planned) return { out: { category: name, options: [], note: 'Already has an approved plan this month.' }, step: `Skipped ${name}: it already has an approved plan.` };
      const out = [...sit.options.values()].filter((o) => o.category === name).map((o) => ({ id: o.id, plan: o.description, saves: usd(o.savingsCents), ...(o.co2AvoidedKg ? { co2Avoided: `${o.co2AvoidedKg} kg CO2` } : {}) }));
      return { out: { category: name, options: out }, step: out.length ? `Listed ${name} plans: ${out.map((o) => `${lowerFirst(o.plan)} (${o.saves})`).join(', ')}.` : `No ${name} plans save anything right now.` };
    }
    case 'getPlanHistory': {
      const out = sit.history.map((h) => ({ plan: h.description, type: TYPE_TEXT[h.type] ?? h.type, month: h.month, result: h.result }));
      const missed = out.filter((h) => h.result === 'missed' || h.result === 'over').length;
      return { out: out.length ? out : { note: 'No past plans yet.' }, step: out.length ? `Checked your past plans: ${out.length} approved, ${missed} missed or over.` : 'Checked your past plans: none yet.' };
    }
    case 'simulate': {
      const r = simulate(sit, args.optionIds);
      if (r.errors.length) return { out: { errors: r.errors }, step: `Tried a combination that didn't work: ${r.errors[0]}.` };
      const out = { totalSaves: usd(r.totalCents), ...afterText(r.afterCents) };
      return { out, step: `Tried ${r.chosen.map((o) => lowerFirst(o.description)).join(' + ')}: saves ${out.totalSaves}, ${out.stillOverBudgetBy ? `still ${out.stillOverBudgetBy} over` : `back under by ${out.backUnderBudgetBy}`}.` };
    }
    default:
      return { out: { error: `unknown tool "${name}"` }, step: `Called an unknown tool "${name}".` };
  }
}

const numbersIn = (text) => (String(text).match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ''));

// Checks the agent's final proposal. Returns errors (sent back to the agent) or the plan.
function checkProposal(sit, args, seenNumbers) {
  const r = simulate(sit, args.optionIds);
  const errors = [...r.errors];
  const reasons = new Map((Array.isArray(args.reasons) ? args.reasons : []).map((x) => [x?.optionId, String(x?.why ?? '').trim()]));
  if (typeof args.summary !== 'string' || !args.summary.trim()) errors.push('summary is required');
  for (const o of r.chosen) if (!reasons.get(o.id)) errors.push(`give a reason for ${o.id}`);
  for (const text of [args.summary, ...r.chosen.map((o) => reasons.get(o.id))]) {
    for (const n of numbersIn(text ?? '')) {
      if (!seenNumbers.has(n) && !(Number(n) <= 10 && /^\d+$/.test(n))) errors.push(`"${n}" is not a figure from the tools; copy figures exactly`);
    }
  }
  if (errors.length) return { errors };
  return { plan: { items: r.chosen.map((o) => ({ ...o, why: reasons.get(o.id) })), totalCents: r.totalCents, afterCents: r.afterCents, summary: args.summary.trim() } };
}

const SYSTEM = `You are Budget Guardian's planning agent. The user's month is heading over budget. Your job: find a realistic plan to get back under, and propose it for the user to approve.

How to work:
- Gather facts with the tools first. Call several tools in one turn when you can.
- Check which categories are spiking and why, and look at getPlanHistory: prefer plan types the user has kept, and avoid ones they keep missing.
- Only use option ids returned by getPlanOptions, at most one per category (options in one category are alternatives).
- Use simulate to check a combination before proposing it. Try another combination if a better one exists.
- If no combination covers everything, propose the one that gets closest and that the user is likely to keep, and say honestly what is left.
- Never calculate or invent numbers. Copy figures exactly as the tools wrote them (e.g. "$77.99").
- Only flexible categories can be cut; the user decided that. Never judge purchases as needs or wants.
- Nothing happens until the user approves: describe the plan as a proposal.
- Finish by calling proposePlan once: a 1-2 sentence summary, and one short sentence per option saying why you chose it.`;

// The tool-using loop. `turn` is injectable for tests. Returns { plan, trace } or throws.
async function runAgent(sit, { turn }) {
  const goal = `Goal: the month is heading ${usd(sit.overCents)} over the ${usd(sit.budget.budgetCents)} budget. Approved plans already cover ${usd(sit.committedCents)}, so ${usd(sit.gapCents)} is still to cover. Make a plan.`;
  const seenNumbers = new Set(numbersIn(goal));
  const contents = [{ role: 'user', parts: [{ text: goal }] }];
  const trace = [];
  for (let i = 0; i < MAX_TURNS; i++) {
    const { content, calls } = await turn({ system: SYSTEM, contents, functionDeclarations: TOOLS });
    contents.push(content);
    if (!calls.length) {
      contents.push({ role: 'user', parts: [{ text: 'Use the tools, then finish by calling proposePlan.' }] });
      continue;
    }
    const responses = [];
    let done = null;
    for (const call of calls) {
      if (call.name === 'proposePlan') {
        const checked = checkProposal(sit, call.args, seenNumbers);
        if (checked.plan) {
          trace.push({ tool: call.name, text: 'Proposed the plan below.' });
          done = checked.plan;
          responses.push({ functionResponse: { name: call.name, response: { ok: true } } });
        } else {
          trace.push({ tool: call.name, text: `First proposal failed the checks (${checked.errors[0]}), so it was revised.` });
          responses.push({ functionResponse: { name: call.name, response: { ok: false, errors: checked.errors } } });
        }
        continue;
      }
      const { out, step } = runTool(sit, call.name, call.args);
      for (const n of numbersIn(JSON.stringify(out))) seenNumbers.add(n);
      trace.push({ tool: call.name, text: step });
      responses.push({ functionResponse: { name: call.name, response: { result: out } } });
    }
    if (done) return { plan: done, trace };
    contents.push({ role: 'user', parts: responses });
  }
  throw new Error(`no valid plan after ${MAX_TURNS} turns`);
}

// The fallback: largest savings first, one option per category, skipping plan types the
// user keeps missing, until the gap is covered.
export function rulesPlan(sit) {
  const avoid = missedTypes(sit);
  const trace = [{ tool: 'getBudgetStatus', text: `Checked the budget: heading ${usd(sit.overCents)} over ${usd(sit.budget.budgetCents)}${sit.committedCents ? `, ${usd(sit.committedCents)} already covered` : ''}.` }];
  if (avoid.size) trace.push({ tool: 'getPlanHistory', text: `Skipped ${[...avoid].map((t) => TYPE_TEXT[t]).join(' and ')}: you missed those plans before.` });
  const best = new Map();
  for (const o of sit.options.values()) {
    if (avoid.has(o.type)) continue;
    if (!best.has(o.category) || o.savingsCents > best.get(o.category).savingsCents) best.set(o.category, o);
  }
  const items = [];
  let total = 0;
  for (const o of [...best.values()].sort((a, b) => b.savingsCents - a.savingsCents)) {
    if (total >= sit.gapCents) break;
    const spike = sit.report.spikes.find((s) => s.category === o.category);
    items.push({ ...o, why: spike ? `${o.category[0].toUpperCase()}${o.category.slice(1)} is ${usd(spike.increaseCents)} above usual, and this is its largest saving.` : `The largest saving available in ${o.category}.` });
    total += o.savingsCents;
  }
  const afterCents = sit.gapCents - total;
  if (items.length) trace.push({ tool: 'simulate', text: `Picked the largest saving in each flexible category until the gap was covered: saves ${usd(total)}, ${afterCents > 0 ? `still ${usd(afterCents)} over` : `back under by ${usd(-afterCents)}`}.` });
  const summary = !items.length
    ? 'There are no savings plans in your flexible categories right now.'
    : afterCents > 0
      ? `This plan saves ${usd(total)}, which leaves you ${usd(afterCents)} over budget; the rest would need cuts in categories you haven't marked as flexible.`
      : `This plan saves ${usd(total)} and brings the month back under budget by ${usd(-afterCents)}.`;
  return { plan: { items, totalCents: total, afterCents, summary }, trace };
}

// --- Caching and background generation, like the advice (see advisor.js).

const RETRY_AFTER_MS = 2 * 60_000;
const inFlight = new Map();
const lastFailure = new Map();

const cacheKey = (sit) =>
  createHash('sha256').update(JSON.stringify({
    rescue: PROMPT_VERSION,
    model: AI_MODEL,
    gap: sit.gapCents,
    budget: sit.budget.budgetCents,
    options: [...sit.options.values()].map((o) => [o.id, o.savingsCents]),
    history: sit.history.map((h) => [h.type, h.result]),
    spikes: sit.report.spikes.map((s) => [s.category, s.increaseCents]),
  })).digest('hex');

// Rebuilds a cached plan against current options (the key includes them, so they match).
function fromCache(sit, cached) {
  const items = cached.items.map((i) => ({ ...sit.options.get(i.optionId), why: i.why }));
  const totalCents = items.reduce((s, o) => s + o.savingsCents, 0);
  return { plan: { items, totalCents, afterCents: sit.gapCents - totalCents, summary: cached.summary }, trace: cached.trace };
}

async function generate(sit, key, turn) {
  const result = await runAgent(sit, { turn });
  const stored = { items: result.plan.items.map((i) => ({ optionId: i.id, why: i.why })), summary: result.plan.summary, trace: result.trace };
  sit.db.prepare('INSERT OR REPLACE INTO ai_cache (key, model, response) VALUES (?, ?, ?)').run(key, AI_MODEL, JSON.stringify(stored));
  return result;
}

const publicPlan = (plan) => ({
  ...plan,
  items: plan.items.map((o) => ({ optionId: o.id, category: o.category, type: o.type, description: o.description, savingsCents: o.savingsCents, co2AvoidedKg: o.co2AvoidedKg, why: o.why })),
});

// The rescue plan for this month. With wait: false (the dashboard) an uncached agent plan is
// generated in the background and the rules plan is returned meanwhile (pending: true).
export async function rescuePlan(db, report, { turn = chatTurn, useAI = aiAvailable(), wait = true } = {}) {
  const sit = situation(db, report);
  const goal = { budgetCents: sit.budget.budgetCents, overCents: sit.overCents, committedCents: sit.committedCents, gapCents: sit.gapCents };
  if (!sit.budget.set) return { status: 'no_budget', goal };
  if (sit.gapCents <= 0) return { status: sit.overCents > 0 ? 'covered' : 'on_track', goal };

  const respond = (r, extra) => ({ status: 'needed', goal, plan: publicPlan(r.plan), trace: r.trace, ...extra });
  const fallback = (extra) => respond(rulesPlan(sit), { source: 'rules', ...extra });
  if (!useAI) return fallback({});

  const key = cacheKey(sit);
  const cached = db.prepare('SELECT response FROM ai_cache WHERE key = ?').get(key);
  if (cached) return respond(fromCache(sit, JSON.parse(cached.response)), { source: 'ai', model: AI_MODEL });

  if (!wait) {
    const failed = lastFailure.get(key);
    if (!inFlight.has(key) && !(failed && Date.now() - failed.at < RETRY_AFTER_MS)) {
      const p = generate(sit, key, turn)
        .then(() => lastFailure.delete(key))
        .catch((err) => lastFailure.set(key, { at: Date.now(), message: err.message }))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, p);
    }
    return fallback({ pending: inFlight.has(key), ...(failed && { aiError: failed.message }) });
  }
  try {
    return respond(await generate(sit, key, turn), { source: 'ai', model: AI_MODEL });
  } catch (err) {
    return fallback({ aiError: err.message });
  }
}

export const rescueIdle = () => Promise.all([...inFlight.values()]);

// Approves each plan in the rescue plan, one after another, through the normal approval
// flow (amount rechecked, balance checked, one plan per category). Returns each result.
export async function approveRescue(db, items, opts = {}, asOf) {
  if (!Array.isArray(items) || !items.length) throw new ApprovalError(400, 'items must list the plans to approve');
  const results = [];
  for (const { optionId, expectedAmountCents } of items) {
    try {
      const { approval } = await approve(db, { optionId, expectedAmountCents, asOf }, opts);
      results.push({ optionId, ok: approval.status !== 'failed', approval });
    } catch (err) {
      if (!(err instanceof ApprovalError)) throw err;
      results.push({ optionId, ok: false, status: err.status, error: err.message });
    }
  }
  return results;
}
