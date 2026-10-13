// Monthly totals per category for charts: every baseline month plus the current month,
// whose projected remainder comes from the spike detector (so the chart and the alert
// always show the same numbers).

export function monthlyHistory(db, report) {
  const { month, asOf, baselineMonths } = report;
  const months = [...baselineMonths, month];
  const endExclusive = new Date(Date.parse(`${asOf}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const rows = db
    .prepare(`
      SELECT COALESCE(category, seed_category) AS category, substr(occurred_at, 1, 7) AS month, SUM(amount_cents) AS cents
      FROM transactions
      WHERE occurred_at >= ? AND occurred_at < ? AND COALESCE(category, seed_category) IS NOT NULL
      GROUP BY 1, 2
    `)
    .all(`${months[0]}-01`, endExclusive);

  const totals = new Map(rows.map((r) => [`${r.category}|${r.month}`, r.cents]));
  return {
    month,
    months,
    categories: report.categories.map((c) => ({
      category: c.category,
      isSpike: c.isSpike,
      usualCents: c.baselineAvgCents,
      projectedCents: c.projectedCents,
      months: months.map((m) => {
        const cents = totals.get(`${c.category}|${m}`) ?? 0;
        return m === month
          ? { month: m, cents, projectedRestCents: Math.max(0, c.projectedCents - cents), current: true }
          : { month: m, cents, current: false };
      }),
    })),
  };
}
