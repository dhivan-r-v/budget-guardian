// Habit insights: small, frequent purchases from past months, with what cutting them
// back would save. Plain arithmetic on integer cents, no LLM involved.
//
// A habit is a group of one-off (non-recurring) purchases in a flexible category that,
// across the baseline months, happens often, regularly and in small amounts. Purchases
// are grouped by category + description (so "Coffee" at Starbucks and Dunkin is one
// habit), or by merchant when there is no description.
import { isFlexible } from './savings.js';

export const HABIT_RULES = {
  minPerMonth: 4, // on average across baseline months
  minMonths: 3, // seen in at least this many baseline months (or all, if there are fewer)
  maxAverageCents: 3000, // small purchases only: groceries and fill-ups are not habits
  cutBackPercent: 50,
};

export function habitInsights(db, report, rules = HABIT_RULES) {
  const { month, asOf, baselineMonths } = report;
  const nBase = baselineMonths.length;
  if (!nBase) return [];
  const endExclusive = new Date(Date.parse(`${asOf}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  const rows = db
    .prepare(`
      SELECT COALESCE(category, seed_category) AS category,
             merchant,
             COALESCE(NULLIF(description, ''), merchant) AS label,
             substr(occurred_at, 1, 7) AS month,
             amount_cents
      FROM transactions
      WHERE occurred_at >= ? AND occurred_at < ?
        AND COALESCE(category, seed_category) IS NOT NULL
        AND COALESCE(is_recurring, seed_recurring, 0) = 0
    `)
    .all(`${baselineMonths[0]}-01`, endExclusive);

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.category}\u0000${r.label}`;
    if (!groups.has(key)) {
      groups.set(key, { category: r.category, label: r.label, merchants: new Set(), months: new Set(), baseCount: 0, baseCents: 0, nowCount: 0, nowCents: 0 });
    }
    const g = groups.get(key);
    if (r.month === month) {
      g.nowCount++;
      g.nowCents += r.amount_cents;
    } else {
      g.merchants.add(r.merchant);
      g.months.add(r.month);
      g.baseCount++;
      g.baseCents += r.amount_cents;
    }
  }

  const minMonths = Math.min(rules.minMonths, nBase);
  const habits = [];
  for (const g of groups.values()) {
    if (!g.baseCount) continue;
    const perMonth = g.baseCount / nBase;
    const averageCents = Math.round(g.baseCents / g.baseCount);
    if (perMonth < rules.minPerMonth || g.months.size < minMonths || averageCents > rules.maxAverageCents) continue;
    if (!isFlexible(db, g.category)) continue;

    const monthlyCents = Math.round(g.baseCents / nBase);
    const savingsPerMonthCents = Math.round((monthlyCents * rules.cutBackPercent) / 100);
    habits.push({
      id: `habit:${g.category}:${g.label}`,
      category: g.category,
      label: g.label,
      merchants: [...g.merchants].sort(),
      monthsSeen: g.months.size,
      perMonth: Math.round(perMonth * 10) / 10,
      averageCents,
      monthlyCents,
      yearlyCents: monthlyCents * 12,
      thisMonth: { count: g.nowCount, cents: g.nowCents },
      cutBack: {
        percent: rules.cutBackPercent,
        perMonth: Math.round((perMonth * (100 - rules.cutBackPercent)) / 10) / 10,
        savingsPerMonthCents,
        savingsPerYearCents: savingsPerMonthCents * 12,
      },
    });
  }
  return habits.sort((a, b) => b.monthlyCents - a.monthlyCents);
}
