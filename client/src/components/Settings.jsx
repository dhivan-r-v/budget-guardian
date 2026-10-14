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
