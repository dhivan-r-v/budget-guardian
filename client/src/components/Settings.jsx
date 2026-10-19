import { useEffect, useState } from 'react';
import { api, usd } from '../api.js';
import { CategoryIcon, Icon } from './Icons.jsx';
import { pushSupport, currentSubscription, turnOn, turnOff, sendTest, resync } from '../push.js';

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

// Alerts on this device (Web Push): spikes and plans going off track show up as
// notifications, without opening the dashboard. Each browser turns them on for itself.
export function AlertsSetting({ alerts, onChanged }) {
  const support = pushSupport();
  const [sub, setSub] = useState(undefined); // undefined while checking
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);

  useEffect(() => {
    let live = true;
    currentSubscription()
      .then(async (s) => {
        if (s) await resync(s).catch(() => null); // keeps the server in step after a reset
        if (live) setSub(s ?? null);
      })
      .catch(() => live && setSub(null));
    return () => { live = false; };
  }, []);

  async function run(fn) {
    setBusy(true);
    setNote(null);
    try {
      await fn();
    } catch (err) {
      setNote({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }
  const on = () => run(async () => {
    const r = await turnOn(alerts.publicKey);
    setSub(await currentSubscription());
    setNote({ ok: true, text: r.delivered ? `Alerts are on. ${r.delivered === 1 ? 'This month’s alert was' : `This month’s ${r.delivered} alerts were`} sent to this device.` : 'Alerts are on for this device.' });
    onChanged({});
  });
  const off = () => run(async () => {
    await turnOff();
    setSub(null);
    setNote({ ok: true, text: 'Alerts are off for this device.' });
    onChanged({});
  });
  const test = () => run(async () => {
    await sendTest(sub.endpoint);
    setNote({ ok: true, text: 'Test alert sent. It should appear in a few seconds.' });
  });

  return (
    <div className="card">
      <label style={{ fontWeight: 650 }}>Alerts on this device</label>
      <p className="muted" style={{ marginTop: 4 }}>A notification when a category starts spiking or an approved plan goes off track. Nothing else, and never ads.</p>
      {support === 'ios-home-screen' && <p className="muted" style={{ marginTop: 8 }}>On iPhone and iPad: tap Share, then <strong>Add to Home Screen</strong>, and open Budget Guardian from there to turn alerts on.</p>}
      {support === 'insecure' && <p className="muted" style={{ marginTop: 8 }}>Alerts need a secure (https) address.</p>}
      {support === 'unsupported' && <p className="muted" style={{ marginTop: 8 }}>This browser can't show notifications. Try Chrome, Edge, Firefox or Safari.</p>}
      {support === 'ok' && sub !== undefined && (
        <div className="actions" style={{ marginTop: 12 }}>
          {sub ? (
            <>
              <span className="status-pill ok"><Icon name="check" size={12} />On</span>
              <button type="button" className="btn ghost" disabled={busy} onClick={test}>Send a test alert</button>
              <button type="button" className="btn ghost" disabled={busy} onClick={off}>Turn off</button>
            </>
          ) : (
            <button type="button" className="btn" disabled={busy} onClick={on}>{busy ? 'Turning on…' : 'Turn on alerts'}</button>
          )}
        </div>
      )}
      {note && <p className={note.ok ? 'muted' : 'error'} role="status" style={{ marginTop: 8 }}>{note.text}</p>}
      {alerts.alerts.length > 0 && (
        <ul className="alert-list">
          {alerts.alerts.slice(0, 4).map((a) => (
            <li key={a.key}><Icon name={a.kind === 'spike' ? 'alert' : 'refresh'} size={12} /><span className="grow">{a.title}</span><span className="muted">{a.sentTo} device{a.sentTo === 1 ? '' : 's'}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}
