// Monthly budget: what is still safe to spend, per day, and whether spikes push the month
// over budget. Plain arithmetic on integer cents, no LLM involved.
//
//   safe to spend = budget - spent so far - recurring charges still to come this month
// Recurring charges (subscriptions, bills) not billed yet are already committed, so they
// are never shown as spendable. Spending numbers come from the same detectSpikes() report
// as the alerts, so the budget and the spike cards always agree.

export function getBudget(db) {
  const v = db.prepare("SELECT value FROM settings WHERE key = 'monthly_budget_cents'").get()?.value;
  return v === undefined ? null : Number(v);
}

export function setBudget(db, cents) {
  if (!Number.isInteger(cents) || cents <= 0 || cents > 100_000_000) throw new RangeError('budget must be a positive whole number of cents up to $1,000,000');
  db.prepare("INSERT INTO settings (key, value) VALUES ('monthly_budget_cents', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(cents));
}

export function budgetStatus(db, report) {
  const budgetCents = getBudget(db);
  const { daysElapsed, daysInMonth } = report;
  const sum = (f) => report.categories.reduce((s, c) => s + f(c), 0);

  const spentCents = sum((c) => c.currentCents);
  const upcomingRecurringCents = sum((c) => Math.max(0, c.usualRecurringCents - c.recurringCents));
  const projectedCents = sum((c) => c.projectedCents);
  const usualCents = sum((c) => c.baselineAvgCents);
  const daysLeft = daysInMonth - daysElapsed; // today counts as used: spending so far includes it

  const base = { budgetCents, spentCents, upcomingRecurringCents, projectedCents, usualCents, daysLeft };
  if (budgetCents === null) return { ...base, set: false };

  const safeToSpendCents = budgetCents - spentCents - upcomingRecurringCents;
  const projectedVsBudgetCents = projectedCents - budgetCents; // > 0 means over budget
  // How much of the projected month each spike adds above that category's usual month.
  const spikes = report.spikes.map((s) => ({ category: s.category, increaseCents: s.increaseCents }));
  const spikeIncreaseCents = spikes.reduce((s, x) => s + x.increaseCents, 0);

  return {
    ...base,
    set: true,
    safeToSpendCents,
    perDayCents: daysLeft > 0 ? Math.floor(Math.max(0, safeToSpendCents) / daysLeft) : 0,
    spentPct: Math.round((spentCents / budgetCents) * 1000) / 10,
    monthElapsedPct: Math.round((daysElapsed / daysInMonth) * 1000) / 10,
    projectedVsBudgetCents,
    overBudget: projectedVsBudgetCents > 0,
    spikes,
    // Over budget, but the spikes alone account for the overspend: without them the month fits.
    spikesCauseOverspend: projectedVsBudgetCents > 0 && projectedVsBudgetCents <= spikeIncreaseCents,
  };
}
