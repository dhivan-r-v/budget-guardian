import { useState } from 'react';
import { api, usd } from '../api.js';
import { CategoryIcon } from './Icons.jsx';

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
      <label htmlFor="budget">Monthly budget</label>
      <p className="muted">What you can spend in a month after rent and savings. Your usual month is {usd(budget.usualCents)}.</p>
      <div className="actions">
        <span className="money-input"><span aria-hidden="true">$</span><input id="budget" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="1100" /></span>
        <button type="submit" className="btn" disabled={busy}>{busy ? 'Saving…' : budget.set ? 'Update' : 'Set budget'}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}

// The user, never the AI, decides which categories are flexible.
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
      <label style={{ fontWeight: 650 }}>Where you're willing to cut back</label>
      <p className="muted" style={{ marginTop: 4 }}>Plans and habits only appear for these categories.</p>
      <div className="prefs">
        {categories.map((c) => (
          <label key={c.category} className="pref">
            <CategoryIcon category={c.category} size={16} />
            <span className="grow">{c.category}</span>
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

// Email alerts are set up on the server (RESEND_API_KEY, ALERT_EMAIL_TO); this shows whether
// they're on and what was sent.
export function AlertsSetting({ alerts }) {
  const [note, setNote] = useState(null);
  const [busy, setBusy] = useState(false);
  async function test() {
    setBusy(true);
    try {
      const r = await api('/api/alerts/test', { method: 'POST' });
      setNote({ ok: true, text: `Test email sent to ${r.to}.` });
    } catch (err) {
      setNote({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <label style={{ fontWeight: 650 }}>Email alerts</label>
      {alerts.configured ? (
        <>
          <p className="muted" style={{ marginTop: 4 }}>On. Emails go to {alerts.to} when a category starts spiking and when an approved plan goes off track.</p>
          {alerts.alerts.length > 0 && (
            <ul className="alert-list">
              {alerts.alerts.slice(0, 4).map((a) => (
                <li key={a.key}><span className="grow">{a.subject}</span><span className={`plan-tag ${a.status === 'sent' ? 'good' : a.status === 'failed' ? 'bad' : ''}`}>{a.status === 'sent' ? 'Sent' : a.status === 'failed' ? 'Failed' : 'Sending'}</span></li>
              ))}
            </ul>
          )}
          <button type="button" className="btn ghost" style={{ marginTop: 12 }} disabled={busy} onClick={test}>{busy ? 'Sending…' : 'Send a test email'}</button>
          {note && <p className={note.ok ? 'muted' : 'error'} role="status" style={{ marginTop: 8 }}>{note.text}</p>}
        </>
      ) : (
        <p className="muted" style={{ marginTop: 4 }}>Off. Set RESEND_API_KEY and ALERT_EMAIL_TO on the server to get an email when a spike starts, without opening the dashboard.</p>
      )}
    </div>
  );
}
