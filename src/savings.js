// Savings suggestions: plain arithmetic on integer cents, no LLM involved.
// The LLM later turns these options into friendly text; it never computes amounts.
//
// Only categories the user marked as flexible get suggestions.
//   fuel:          replace some driving days with public transport (money + CO2)
//   entertainment: skip subscriptions not yet billed this month
//   anything else: cut back one-off spending for the rest of the month

export const DEFAULTS = {
  gasPricePerGallonCents: 350, // assumed US average price of regular gasoline
  co2KgPerGallon: 8.887, // EPA: CO2 from burning one gallon of gasoline
  transitFarePerDayCents: 550, // two $2.75 rides (there and back)
  transitDayOptions: [2, 3],
  cutBackPercents: [25, 50],
};

export function isFlexible(db, category) {
  return Boolean(db.prepare('SELECT flexible FROM category_prefs WHERE category = ?').get(category)?.flexible);
}

export function setFlexible(db, category, flexible) {
  db.prepare(`
    INSERT INTO category_prefs (category, flexible) VALUES (?, ?)
    ON CONFLICT (category) DO UPDATE SET flexible = excluded.flexible
  `).run(category, flexible ? 1 : 0);
}

const pctOf = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

// Replacing a driving day with public transport saves that day's fuel minus the fare.
// "A day's fuel" is this month's fuel spending per day so far, since that is how the
// user is driving right now; it falls back to the usual rate if nothing was spent yet.
// Early in a month a fill-up covers more days than have passed, so the rate is averaged
// over at least MIN_RATE_DAYS (otherwise 2 fill-ups on day 2 would read as $49/day).
const MIN_RATE_DAYS = 7;
function publicTransportOptions(entry, report, opts) {
  const { daysElapsed, daysInMonth } = report;
  const remainingDays = daysInMonth - daysElapsed;
  const dailyFuelCents =
    entry.oneOffCents > 0
      ? entry.oneOffCents / Math.max(daysElapsed, MIN_RATE_DAYS)
      : entry.usualOneOffCents / daysInMonth;

  const options = [];
  for (const days of opts.transitDayOptions) {
    if (days > remainingDays) continue;
    const fuelAvoidedCents = Math.round(dailyFuelCents * days);
    const transitCostCents = opts.transitFarePerDayCents * days;
    const savingsCents = fuelAvoidedCents - transitCostCents;
    if (savingsCents <= 0) continue; // transit would cost more than the fuel it replaces
    const gallons = fuelAvoidedCents / opts.gasPricePerGallonCents;
    options.push({
      id: `${entry.category}:public_transport:${days}`,
      type: 'public_transport',
      transitDays: days,
      fuelAvoidedCents,
      transitCostCents,
      savingsCents,
      gallonsAvoided: Math.round(gallons * 10) / 10,
      co2AvoidedKg: Math.round(gallons * opts.co2KgPerGallon * 10) / 10,
      coversPctOfIncrease: pctOf(savingsCents, entry.increaseCents),
    });
  }
  return {
    options,
    assumptions: {
      dailyFuelCents: Math.round(dailyFuelCents),
      remainingDays,
      transitFarePerDayCents: opts.transitFarePerDayCents,
      gasPricePerGallonCents: opts.gasPricePerGallonCents,
      co2KgPerGallon: opts.co2KgPerGallon,
    },
  };
}

// Active subscriptions = recurring merchants charged in the last full month or this month.
// Skipping one saves its amount this month only if it hasn't been billed yet.
function subscriptionOptions(db, entry, report) {
  const { month, asOf, baselineMonths } = report;
  const lastFull = baselineMonths.at(-1) ?? month;
  const endExclusive = new Date(Date.parse(`${asOf}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const rows = db
    .prepare(`
      SELECT merchant, occurred_at, amount_cents
      FROM transactions
      WHERE COALESCE(category, seed_category) = ?
        AND COALESCE(is_recurring, seed_recurring, 0) = 1
        AND occurred_at >= ? AND occurred_at < ?
      ORDER BY occurred_at
    `)
    .all(entry.category, `${lastFull}-01`, endExclusive);

  const byMerchant = new Map(); // latest charge wins
  for (const r of rows) {
    const chargedThisMonth = r.occurred_at.startsWith(month) || byMerchant.get(r.merchant)?.chargedThisMonth;
    byMerchant.set(r.merchant, {
      merchant: r.merchant,
      amountCents: r.amount_cents,
      billingDay: Number(r.occurred_at.slice(8, 10)),
      chargedThisMonth: Boolean(chargedThisMonth),
    });
  }
  const subscriptions = [...byMerchant.values()]
    .map((s) => ({ ...s, savingsThisMonthCents: s.chargedThisMonth ? 0 : s.amountCents }))
    .sort((a, b) => b.savingsThisMonthCents - a.savingsThisMonthCents || b.amountCents - a.amountCents);
  if (!subscriptions.length) return { options: [] };

  const savingsCents = subscriptions.reduce((sum, s) => sum + s.savingsThisMonthCents, 0);
  return {
    options: [
      {
        id: `${entry.category}:skip_subscriptions`,
        type: 'skip_subscriptions',
        subscriptions,
        savingsCents, // this month: only subscriptions not billed yet
        monthlyCents: subscriptions.reduce((sum, s) => sum + s.amountCents, 0),
        coversPctOfIncrease: pctOf(savingsCents, entry.increaseCents),
      },
    ],
  };
}

// Generic fallback: spend less than usual on one-offs for the rest of the month.
function cutBackOptions(entry, report, opts) {
  const { daysElapsed, daysInMonth } = report;
  const usualRemainingCents = Math.round((entry.usualOneOffCents * (daysInMonth - daysElapsed)) / daysInMonth);
  const options = opts.cutBackPercents
    .map((percent) => ({
      id: `${entry.category}:cut_back:${percent}`,
      type: 'cut_back',
      percent,
      savingsCents: Math.round((usualRemainingCents * percent) / 100),
    }))
    .filter((o) => o.savingsCents > 0)
    .map((o) => ({ ...o, coversPctOfIncrease: pctOf(o.savingsCents, entry.increaseCents) }));
  return { options, assumptions: { usualRemainingCents } };
}

// `report` is the result of detectSpikes(); `entry` is one of its categories.
export function suggestSavings(db, report, entry, overrides = {}) {
  const opts = { ...DEFAULTS, ...overrides };
  const base = { category: entry.category, increaseCents: entry.increaseCents };
  if (!isFlexible(db, entry.category)) {
    return { ...base, flexible: false, options: [] };
  }
  let result;
  if (entry.category === 'fuel') result = publicTransportOptions(entry, report, opts);
  else if (entry.category === 'entertainment') result = subscriptionOptions(db, entry, report);
  else result = cutBackOptions(entry, report, opts);
  return { ...base, flexible: true, ...result };
}

export function suggestSavingsForSpikes(db, report, overrides) {
  return {
    ...report,
    spikes: report.spikes.map((s) => ({ ...s, savings: suggestSavings(db, report, s, overrides) })),
  };
}
