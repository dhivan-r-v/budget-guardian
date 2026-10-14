import { useState } from 'react';
import { api, usd, monthLong, capitalize, STATUS_TEXT } from '../api.js';

export function Header({ month, daysElapsed, daysInMonth, demo, asOf }) {
  return (
    <header className="top">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" />
          </svg>
        </div>
        <h1>Budget Guardian</h1>
      </div>
      <div className="month">
        {monthLong(month)} · day {daysElapsed} of {daysInMonth}
        <div className="progress" aria-hidden="true"><span style={{ width: `${(daysElapsed / daysInMonth) * 100}%` }} /></div>
      </div>
      <div className="badges">
        {demo && <span className="promise" title="Seeded demo history plus your PayPal sandbox transactions; no real money.">Sandbox demo · seeded history + PayPal sandbox</span>}
        <span className="promise">🔒 Nothing moves until you approve</span>
      </div>
    </header>
  );
}

// Budget meter: spent, recurring still to come, and what's left, with a marker for how far
// through the month we are (spending past the marker = ahead of pace).
function BudgetMeter({ budget }) {
  const total = Math.max(budget.budgetCents, budget.spentCents + budget.upcomingRecurringCents);
  const pct = (c) => `${Math.max(0, (c / total) * 100)}%`;
  return (
    <div className="meter-wrap">
      <div className="meter" role="img" aria-label={`Spent ${usd(budget.spentCents)}, ${usd(budget.upcomingRecurringCents)} in bills still to come, of a ${usd(budget.budgetCents)} budget`}>
        <span style={{ width: pct(budget.spentCents), background: 'var(--series-1)' }} />
        {budget.upcomingRecurringCents > 0 && <span style={{ width: pct(budget.upcomingRecurringCents), background: 'var(--series-1-soft)' }} />}
        <i className="meter-mark" style={{ left: `${(budget.monthElapsedPct / 100) * (budget.budgetCents / total) * 100}%` }} />
      </div>
      <ul className="legend">
        <li><span className="swatch" style={{ background: 'var(--series-1)' }} />Spent {usd(budget.spentCents)}</li>
        <li><span className="swatch" style={{ background: 'var(--series-1-soft)' }} />Bills still to come {usd(budget.upcomingRecurringCents)}</li>
        <li><span className="swatch line" style={{ background: 'var(--ink-2)' }} />Today ({Math.round(budget.monthElapsedPct)}% of the month)</li>
      </ul>
    </div>
  );
}

function Outlook({ budget, top }) {
  const over = budget.projectedVsBudgetCents;
  if (over > 0 && budget.spikesCauseOverspend && top) {
    return <>Heading <strong>{usd(over)} over</strong> your {usd(budget.budgetCents)} budget, and the <strong>{top.category}</strong> spike (+{usd(top.increaseCents)}) is why. Without it you'd finish under budget.</>;
  }
  if (over > 0) return <>Heading <strong>{usd(over)} over</strong> your {usd(budget.budgetCents)} budget by month end.</>;
  return <>On track to finish <strong>{usd(-over)} under</strong> your {usd(budget.budgetCents)} budget.</>;
}

// The one headline number (safe to spend), plus supporting tiles.
export function Hero({ spikes, budget, approvals, month, savingsById }) {
  const top = spikes[0];
  const thisMonth = approvals.filter((a) => a.month === month && a.status !== 'failed');
  const saved = thisMonth.reduce((s, a) => s + a.amountCents, 0);
  const co2 = thisMonth.reduce((s, a) => s + (savingsById.get(a.optionId)?.co2AvoidedKg ?? 0), 0);
  return (
    <section className="hero" aria-label="Summary">
      <div className="card">
        {budget.set ? (
          <>
            <p className="hero-label">Safe to spend for the next {budget.daysLeft} day{budget.daysLeft === 1 ? '' : 's'}</p>
            <p className="hero-figure">{usd(Math.max(0, budget.safeToSpendCents))}</p>
            <p className="hero-label">
              About <strong>{usd(budget.perDayCents)} a day</strong>, after {usd(budget.upcomingRecurringCents)} in bills and subscriptions still to come.
            </p>
            <BudgetMeter budget={budget} />
            <p className="hero-outlook"><Outlook budget={budget} top={top} /></p>
          </>
        ) : top ? (
          <>
            <p className="hero-label">On track to overspend on <strong>{top.category}</strong> this month</p>
            <p className="hero-figure">+{usd(top.increaseCents)}</p>
            <p className="hero-label">Heading for {usd(top.projectedCents)} against a usual {usd(top.baselineAvgCents)}. Set a monthly budget below to see what's safe to spend.</p>
          </>
        ) : (
          <>
            <p className="hero-label">This month</p>
            <p className="hero-figure">On track</p>
            <p className="hero-label">No category is heading well above its usual month. Set a monthly budget below to see what's safe to spend.</p>
          </>
        )}
      </div>
      <div className="tiles">
        <div className="tile"><div className="label">Spent so far</div><div className="value">{usd(budget.spentCents)}</div><div className="note">{budget.set ? `${Math.round(budget.spentPct)}% of budget` : 'all categories'}</div></div>
        <div className="tile"><div className="label">Month-end projection</div><div className="value">{usd(budget.projectedCents)}</div><div className="note">usual month {usd(budget.usualCents)}</div></div>
        <div className="tile"><div className="label">Moved to savings</div><div className="value">{usd(saved)}</div><div className="note">{thisMonth.length} approved plan{thisMonth.length === 1 ? '' : 's'}</div></div>
        <div className="tile"><div className="label">CO2 avoided</div><div className="value">{Math.round(co2 * 10) / 10} kg</div><div className="note">from approved plans</div></div>
      </div>
    </section>
  );
}

// The user's monthly budget, in dollars.
export function BudgetSetting({ budget, onChanged }) {
  const [value, setValue] = useState(budget.set ? String(budget.budgetCents / 100) : '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    if (!/^\d+(\.\d{1,2})?$/.test(value.trim()) || Number(value) <= 0) return setError('Enter an amount like 1100 or 1100.50');
    setBusy(true);
    setError(null);
    try {
      await api('/api/budget', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthlyCents: Math.round(Number(value) * 100) }),
      });
      await onChanged({});
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card budget-form" onSubmit={save}>
      <label htmlFor="budget">Monthly budget (USD)</label>
      <p className="muted">What you can spend in a month after rent and savings. Your usual month is {usd(budget.usualCents)}.</p>
      <div className="actions">
        <span className="money-input"><span aria-hidden="true">$</span><input id="budget" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="1100" /></span>
        <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : budget.set ? 'Update budget' : 'Set budget'}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

export function Habits({ habits }) {
  if (!habits.length) return <p className="muted">No small, frequent purchases stood out in your flexible categories.</p>;
  return (
    <div className="grid-2">
      {habits.map((h) => (
        <article key={h.id} className="card">
          <span className="tag"><span className="dot" />{capitalize(h.category)}</span>
          <h3>{h.label}</h3>
          <div className="habit-figure">{usd(h.monthlyCents)}<small> / month</small></div>
          <p className="muted">About {h.perMonth}× a month at {usd(h.averageCents)} · {usd(h.yearlyCents)} a year · {h.merchants.join(', ')}</p>
          <p className="muted">This month so far: {h.thisMonth.count}× for {usd(h.thisMonth.cents)}</p>
          <div className="habit-save">
            Cutting to {h.cutBack.perMonth}× a month saves <strong>{usd(h.cutBack.savingsPerMonthCents)}/month</strong>, {usd(h.cutBack.savingsPerYearCents)} a year.
          </div>
        </article>
      ))}
    </div>
  );
}

export function Approvals({ approvals }) {
  if (!approvals.length) return <div className="card"><p className="muted">No approvals yet. Nothing moves until you approve a plan.</p></div>;
  return (
    <div className="card">
      <table className="data">
        <thead><tr><th>When</th><th>Plan</th><th className="num">Amount</th><th>Status</th></tr></thead>
        <tbody>
          {approvals.map((a) => (
            <tr key={a.id}>
              <td>{a.createdAt.slice(0, 16).replace('T', ' ')}</td>
              <td>{a.description}</td>
              <td className="num">{usd(a.amountCents)}</td>
              <td>
                <span className={`status ${a.status}`}>{STATUS_TEXT[a.status]}</span>
                {a.paypalStatus && <div className="muted">PayPal: {a.paypalStatus}</div>}
                {a.error && <div className="error">{a.error}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ago = (iso) => {
  if (!iso) return 'never';
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
};

// Live PayPal data: sync status, recent PayPal purchases, and a manual sync.
export function PayPalPanel({ status, transactions, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  async function syncNow() {
    setBusy(true);
    setMessage(null);
    try {
      const { result } = await api('/api/paypal/sync', { method: 'POST' });
      setMessage(result.added ? `${result.added} new PayPal purchase${result.added === 1 ? '' : 's'} added.` : 'No new PayPal purchases yet.');
      await onChanged({});
    } catch (err) {
      setMessage(err.status === 429 ? 'Synced a moment ago. Try again in 30 seconds.' : `Sync failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <div className="option" style={{ paddingTop: 0 }}>
        <p className="option-text">
          Last synced {ago(status.lastSyncAt)}
          {status.paypalRefreshedTo && <span className="muted"> · PayPal has reported transactions up to {status.paypalRefreshedTo.slice(0, 16).replace('T', ' ')} UTC (it can lag a few hours)</span>}
        </p>
        <button type="button" className="btn ghost" disabled={busy || status.syncing} onClick={syncNow}>{busy || status.syncing ? 'Syncing…' : 'Sync now'}</button>
      </div>
      {status.lastError && <p className="error">Last sync failed: {status.lastError}</p>}
      {message && <p className="muted" role="status">{message}</p>}
      {transactions.length ? (
        <table className="data">
          <thead><tr><th>Date</th><th>Merchant</th><th>Category</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.id}>
                <td>{t.occurredAt.slice(0, 10)}</td>
                <td>{t.merchant}{t.description ? <div className="muted">{t.description}</div> : null}</td>
                <td>{t.category ? capitalize(t.category) : <span className="muted">Labeling…</span>}</td>
                <td className="num">{usd(t.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No PayPal purchases yet. Spending from your PayPal account appears here and counts toward spikes, alongside your earlier history.</p>
      )}
    </div>
  );
}

// The user — never the AI — decides which categories are flexible.
export function Preferences({ categories, onChanged }) {
  const [busy, setBusy] = useState(null);
  async function toggle(category, flexible) {
    setBusy(category);
    try {
      await api(`/api/categories/${encodeURIComponent(category)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flexible }),
      });
      await onChanged({});
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="card">
      <p className="lede">Choose where you're willing to cut back. Budget Guardian only suggests savings, and finds habits, in these categories.</p>
      <div className="prefs">
        {categories.map((c) => (
          <label key={c.category} className="pref">
            {c.category}
            <span className="switch">
              <input type="checkbox" checked={c.flexible} disabled={busy === c.category} onChange={(e) => toggle(c.category, e.target.checked)} />
              <span />
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
