// Explains what caused a spike: plain arithmetic on integer cents, no LLM involved.
//
// A spike's increase (projected - usual) splits exactly into two parts:
//   recurring excess = recurring charged this month beyond the usual recurring total
//   one-off excess   = one-off spent so far - usual one-off spending expected by today
// The one-off excess is further split (the parts always add up exactly):
//   more often     = (purchases so far - purchases expected by today) x usual purchase amount
//   higher prices  = the rest, i.e. purchases so far x (average amount - usual amount)
// The LLM later turns this breakdown into a friendly explanation; it never computes numbers.

const LARGE_PURCHASE_FACTOR = 2; // a one-off purchase 2x the usual amount is "large"

function categoryRows(db, category, from, toExclusive) {
  return db
    .prepare(`
      SELECT id, occurred_at, merchant, description, amount_cents,
             COALESCE(is_recurring, seed_recurring, 0) AS recurring
      FROM transactions
      WHERE COALESCE(category, seed_category) = ? AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at
    `)
    .all(category, from, toExclusive);
}

const toTxn = (r) => ({
  id: r.id,
  date: r.occurred_at.slice(0, 10),
  merchant: r.merchant,
  description: r.description,
  amountCents: r.amount_cents,
});

// `report` is the result of detectSpikes(); `spike` is one of its categories.
export function explainSpike(db, report, spike) {
  const { month, asOf, daysElapsed, daysInMonth, baselineMonths } = report;
  const nBase = baselineMonths.length;
  const endExclusive = new Date(Date.parse(`${asOf}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  const current = categoryRows(db, spike.category, `${month}-01`, endExclusive);
  const baseline = nBase ? categoryRows(db, spike.category, `${baselineMonths[0]}-01`, `${month}-01`) : [];

  // --- Recurring: new subscriptions and price increases, compared by merchant.
  const usualByMerchant = new Map(); // merchant -> { total, charges }
  for (const r of baseline.filter((r) => r.recurring)) {
    const m = usualByMerchant.get(r.merchant) ?? { total: 0, charges: 0 };
    m.total += r.amount_cents;
    m.charges += 1;
    usualByMerchant.set(r.merchant, m);
  }
  const newSubscriptions = [];
  const priceIncreases = [];
  for (const r of current.filter((r) => r.recurring)) {
    const usual = usualByMerchant.get(r.merchant);
    if (!usual) newSubscriptions.push(toTxn(r));
    else {
      const usualCents = Math.round(usual.total / usual.charges);
      if (r.amount_cents > usualCents) priceIncreases.push({ ...toTxn(r), usualAmountCents: usualCents });
    }
  }
  const recurringExcessCents = Math.max(0, spike.recurringCents - spike.usualRecurringCents);

  // --- One-off: how often vs how much. Matches the detector's projection exactly.
  const oneOffs = current.filter((r) => !r.recurring);
  const usualOneOffCount = nBase ? baseline.filter((r) => !r.recurring).length / nBase : 0;
  const usualAmount = usualOneOffCount > 0 ? spike.usualOneOffCents / usualOneOffCount : 0;
  const remainingCents = Math.round((spike.usualOneOffCents * (daysInMonth - daysElapsed)) / daysInMonth);
  const expectedSoFarCents = spike.usualOneOffCents - remainingCents;
  const expectedCount = (usualOneOffCount * daysElapsed) / daysInMonth;
  const oneOffExcessCents = spike.oneOffCents - expectedSoFarCents;
  const moreOftenCents = Math.round((oneOffs.length - expectedCount) * usualAmount);
  const higherPricesCents = oneOffExcessCents - moreOftenCents;

  const largePurchases = usualAmount
    ? oneOffs.filter((r) => r.amount_cents >= LARGE_PURCHASE_FACTOR * usualAmount).map(toTxn)
    : [];
  largePurchases.sort((a, b) => b.amountCents - a.amountCents);

  // --- Primary cause: the single story that explains the most of the increase.
  const candidates = [
    { cause: 'new_subscription', cents: newSubscriptions.reduce((s, t) => s + t.amountCents, 0) },
    { cause: 'subscription_price_increase', cents: priceIncreases.reduce((s, t) => s + t.amountCents - t.usualAmountCents, 0) },
    // A single large purchase only leads when it alone covers half the increase.
    {
      cause: 'large_purchase',
      cents: largePurchases[0] && largePurchases[0].amountCents - usualAmount >= spike.increaseCents / 2
        ? Math.round(largePurchases[0].amountCents - usualAmount)
        : 0,
    },
    { cause: 'more_often', cents: moreOftenCents },
    { cause: 'higher_prices', cents: higherPricesCents },
  ];
  const primary = candidates.reduce((best, c) => (c.cents > best.cents ? c : best)).cause;

  return {
    category: spike.category,
    increaseCents: spike.increaseCents,
    primaryCause: primary,
    recurring: {
      excessCents: recurringExcessCents,
      newSubscriptions,
      priceIncreases,
    },
    oneOff: {
      excessCents: oneOffExcessCents,
      spentSoFarCents: spike.oneOffCents,
      expectedSoFarCents,
      count: oneOffs.length,
      expectedCount: Math.round(expectedCount * 10) / 10,
      usualMonthlyCount: Math.round(usualOneOffCount * 10) / 10,
      averageAmountCents: oneOffs.length ? Math.round(spike.oneOffCents / oneOffs.length) : 0,
      usualAmountCents: Math.round(usualAmount),
      moreOftenCents,
      higherPricesCents,
    },
    largePurchases,
    transactions: current.map((r) => ({ ...toTxn(r), recurring: Boolean(r.recurring) })),
  };
}

export function explainSpikes(db, report) {
  return { ...report, spikes: report.spikes.map((s) => ({ ...s, cause: explainSpike(db, report, s) })) };
}
