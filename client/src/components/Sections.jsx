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

// The one headline number, plus three supporting tiles.
export function Hero({ spikes, history, approvals, month, savingsById }) {
  const top = spikes[0];
  const spentSoFar = history.categories.reduce((s, c) => s + (c.months.at(-1)?.cents ?? 0), 0);
  const thisMonth = approvals.filter((a) => a.month === month && a.status !== 'failed');
  const saved = thisMonth.reduce((s, a) => s + a.amountCents, 0);
  const co2 = thisMonth.reduce((s, a) => s + (savingsById.get(a.optionId)?.co2AvoidedKg ?? 0), 0);
  return (
    <section className="hero" aria-label="Summary">
      <div className="card">
        {top ? (
          <>
            <p className="hero-label">On track to overspend on <strong>{top.category}</strong> this month</p>
            <p className="hero-figure">+{usd(top.increaseCents)}</p>
            <p className="hero-label">
              Heading for {usd(top.projectedCents)} against a usual {usd(top.baselineAvgCents)}
              {top.increasePct !== null ? ` (${Math.round(top.increasePct)}% above usual)` : ''}.
              {spikes.length > 1 ? ` ${spikes.length - 1} more categor${spikes.length > 2 ? 'ies are' : 'y is'} also above usual.` : ''}
            </p>
          </>
        ) : (
          <>
            <p className="hero-label">This month</p>
            <p className="hero-figure">On track</p>
            <p className="hero-label">No category is heading well above its usual month.</p>
          </>
        )}
      </div>
      <div className="tiles">
        <div className="tile"><div className="label">Spent so far</div><div className="value">{usd(spentSoFar)}</div><div className="note">all categories</div></div>
        <div className="tile"><div className="label">Moved to savings</div><div className="value">{usd(saved)}</div><div className="note">{thisMonth.length} approved plan{thisMonth.length === 1 ? '' : 's'}</div></div>
        <div className="tile"><div className="label">CO2 avoided</div><div className="value">{Math.round(co2 * 10) / 10} kg</div><div className="note">from approved plans</div></div>
        <div className="tile"><div className="label">Spikes</div><div className="value">{spikes.length}</div><div className="note">categories above usual</div></div>
      </div>
    </section>
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
