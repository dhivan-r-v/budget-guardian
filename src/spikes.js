// Spike detection: plain arithmetic on integer cents, no LLM involved.
//
// For each category, the current (partial) month is projected to a full month and
// compared with the average of previous full months:
//   projected = spent so far + usual spending for the rest of the month
// i.e. "even if you spend normally from today, you will end the month at X". Scaling the
// partial total by days instead would turn any early-month cluster of purchases into a
// false alarm. The rest of the month is split into recurring charges still to come
// (usual recurring minus recurring already charged) and the usual daily one-off rate.
//
// Until the LLM categorizer has labeled a transaction, its seed ground-truth label is used
// as a fallback so the detector can be developed and tested on seed data.

const DAY_MS = 86_400_000;

// "Today", unless DEMO_AS_OF pins it (the deployed demo's seed data is built around one date).
export const today = () => process.env.DEMO_AS_OF?.trim() || new Date().toISOString().slice(0, 10);

function parseISODate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`asOf must be YYYY-MM-DD, got "${s}"`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new Error(`invalid date "${s}"`);
  return d;
}

function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function detectSpikes(
  db,
  {
    asOf = today(),
    lookbackMonths = 6, // at most this many previous months form the baseline
    threshold = 0.3, // flag when projected spending is 30%+ above the usual average
    minIncreaseCents = 2500, // ...and at least $25 above it, so tiny categories don't alert
  } = {},
) {
  const asOfDate = parseISODate(asOf);
  const month = asOf.slice(0, 7);
  const daysElapsed = asOfDate.getUTCDate();
  const daysInMonth = new Date(Date.UTC(asOfDate.getUTCFullYear(), asOfDate.getUTCMonth() + 1, 0)).getUTCDate();
  const endExclusive = new Date(asOfDate.getTime() + DAY_MS).toISOString().slice(0, 10);

  // Baseline = full months before the current one, but never earlier than the first
  // month with data (months before history began would wrongly count as $0).
  const first = db.prepare('SELECT MIN(substr(occurred_at, 1, 7)) AS m FROM transactions').get()?.m;
  const lookbackStart = addMonths(month, -lookbackMonths);
  const baselineStart = first && first > lookbackStart ? first : lookbackStart;
  const baselineMonths = [];
  for (let m = baselineStart; m < month; m = addMonths(m, 1)) baselineMonths.push(m);

  const rows = db
    .prepare(`
      SELECT substr(occurred_at, 1, 7)                    AS month,
             COALESCE(category, seed_category)            AS cat,
             COALESCE(is_recurring, seed_recurring, 0)    AS recurring,
             SUM(amount_cents)                            AS cents,
             COUNT(*)                                     AS n
      FROM transactions
      WHERE occurred_at >= ? AND occurred_at < ?
        AND COALESCE(category, seed_category) IS NOT NULL
      GROUP BY 1, 2, 3
    `)
    .all(`${baselineStart}-01`, endExclusive);

  const byCat = new Map();
  const get = (cat) => {
    if (!byCat.has(cat)) {
      byCat.set(cat, { baseTotal: 0, baseRecurring: 0, baseCount: 0, recurring: 0, oneOff: 0, count: 0 });
    }
    return byCat.get(cat);
  };
  for (const r of rows) {
    const c = get(r.cat);
    if (r.month === month) {
      if (r.recurring) c.recurring += r.cents;
      else c.oneOff += r.cents;
      c.count += r.n;
    } else if (baselineMonths.includes(r.month)) {
      c.baseTotal += r.cents;
      if (r.recurring) c.baseRecurring += r.cents;
      c.baseCount += r.n;
    }
  }

  const nBase = baselineMonths.length;
  const categories = [];
  for (const [category, c] of byCat) {
    const baselineAvgCents = nBase ? Math.round(c.baseTotal / nBase) : 0;
    const usualRecurringCents = nBase ? Math.round(c.baseRecurring / nBase) : 0;
    const usualOneOffCents = baselineAvgCents - usualRecurringCents;
    const currentCents = c.recurring + c.oneOff;
    const projectedCents =
      currentCents +
      Math.max(0, usualRecurringCents - c.recurring) +
      Math.round((usualOneOffCents * (daysInMonth - daysElapsed)) / daysInMonth);
    const increaseCents = projectedCents - baselineAvgCents;
    const increasePct = baselineAvgCents > 0 ? Math.round((increaseCents / baselineAvgCents) * 1000) / 10 : null;

    categories.push({
      category,
      baselineAvgCents,
      currentCents,
      projectedCents,
      increaseCents,
      increasePct,
      recurringCents: c.recurring,
      oneOffCents: c.oneOff,
      usualRecurringCents,
      usualOneOffCents,
      transactionCount: c.count,
      baselineAvgTransactionCount: nBase ? Math.round((c.baseCount / nBase) * 10) / 10 : 0,
      // Spent more so far than in a usual whole month.
      alreadyOver: currentCents > baselineAvgCents,
      isSpike: nBase > 0 && projectedCents >= baselineAvgCents * (1 + threshold) && increaseCents >= minIncreaseCents,
    });
  }
  categories.sort((a, b) => b.isSpike - a.isSpike || b.increaseCents - a.increaseCents);

  return {
    asOf,
    demo: Boolean(process.env.DEMO_AS_OF?.trim()) || process.env.DEMO_ROLLING === '1',
    month,
    daysElapsed,
    daysInMonth,
    baselineMonths,
    threshold,
    spikes: categories.filter((c) => c.isSpike),
    categories,
  };
}
