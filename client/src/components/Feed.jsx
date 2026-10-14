import { useState } from 'react';
import { api, usd, capitalize } from '../api.js';
import { CategoryIcon, Icon } from './Icons.jsx';

export function Habits({ habits }) {
  if (!habits.length) return <div className="card"><p className="muted">No small, frequent purchases stood out in your flexible categories.</p></div>;
  return (
    <div className="grid-2">
      {habits.map((h) => (
        <article key={h.id} className="card habit">
          <div className="card-head">
            <CategoryIcon category={h.category} />
            <div className="grow">
              <h3>{h.label}</h3>
              <span className="muted">{h.merchants.join(', ')}</span>
            </div>
          </div>
          <div className="figure">{usd(h.monthlyCents)}<small> / month</small></div>
          <p className="muted">About {h.perMonth}× a month at {usd(h.averageCents)} · {usd(h.yearlyCents)} a year · this month {h.thisMonth.count}× so far</p>
          <div className="save-pill">
            <Icon name="leaf" size={16} />
            <span>Halve it ({h.cutBack.perMonth}× a month) and save <strong>{usd(h.cutBack.savingsPerYearCents)} a year</strong></span>
          </div>
        </article>
      ))}
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
const initials = (name) => name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

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
      <div className="sync-row">
        <div className="grow">
          <div><span className={`live-dot${status.lastError ? ' bad' : ''}`} />{status.lastError ? 'Last sync failed' : `Synced ${ago(status.lastSyncAt)}`}</div>
          {status.paypalRefreshedTo && (
            <span className="muted">PayPal has reported activity up to {new Date(status.paypalRefreshedTo).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. New purchases can take a few hours to appear.</span>
          )}
        </div>
        <button type="button" className="btn ghost small" disabled={busy || status.syncing} onClick={syncNow}>
          <Icon name="refresh" size={14} />{busy || status.syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      {status.lastError && <p className="error">{status.lastError}</p>}
      {message && <p className="muted" role="status" style={{ marginTop: 8 }}>{message}</p>}
      {transactions.length ? (
        <ul className="tx-list">
          {transactions.map((t) => (
            <li key={t.id}>
              <span className="avatar" aria-hidden="true">{initials(t.merchant)}</span>
              <div>
                <div className="merchant">{t.merchant}</div>
                <div className="muted">{new Date(t.occurredAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{t.description ? ` · ${t.description}` : ''} · {t.category ? capitalize(t.category) : 'labeling…'}</div>
              </div>
              <strong className="num">{usd(t.amountCents)}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty">
          <Icon name="wallet" size={18} />
          <span>No PayPal purchases yet. Spending from your PayPal account shows up here and counts toward spikes, alongside your earlier history.</span>
        </div>
      )}
    </div>
  );
}
