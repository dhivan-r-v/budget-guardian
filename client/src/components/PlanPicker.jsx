import { useState } from 'react';
import { api, usd, STATUS_TEXT } from '../api.js';
import { Icon } from './Icons.jsx';

export function planName(category, o) {
  if (o.type === 'public_transport') return `${o.transitDays} days on public transport`;
  if (o.type === 'skip_subscriptions') {
    const names = o.subscriptions.filter((s) => !s.chargedThisMonth).map((s) => s.merchant);
    return names.length ? `Skip ${names.join(' and ')}` : 'Skip subscriptions';
  }
  return `Spend ${o.percent}% less on ${category}`;
}

function chips(o) {
  const out = [];
  if (o.co2AvoidedKg) out.push({ icon: 'leaf', text: `${o.co2AvoidedKg} kg CO2 avoided` });
  if (o.transitCostCents) out.push({ text: `after ${usd(o.transitCostCents)} in fares` });
  if (o.type === 'skip_subscriptions') {
    const billed = o.subscriptions.filter((s) => s.chargedThisMonth).map((s) => s.merchant);
    if (billed.length) out.push({ text: `${billed.join(', ')} already billed` });
  }
  return out;
}

// The category's plans as cards to choose between (they're alternatives), then one approval.
// Nothing moves until the user confirms; the server recomputes the amount and refuses (409)
// if it changed, in which case the page refreshes with the new figures.
export default function PlanPicker({ item, approvals, month, onChanged, onApproved }) {
  const options = item.savings.options.filter((o) => o.savingsCents > 0);
  const textById = new Map(item.advice.options.map((o) => [o.id, o.text]));
  const live = approvals.find((a) => a.category === item.category && a.month === month && a.status !== 'failed');
  const [selectedId, setSelectedId] = useState(options.at(-1)?.id ?? null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (live) {
    const done = live.status === 'completed';
    return (
      <div className={`done${done ? '' : ' pending'}`} role="status">
        <span className={`dot ${live.status}`}><Icon name={done ? 'check' : 'refresh'} size={16} /></span>
        <div>
          <strong>{done ? `${usd(live.amountCents)} moved to your savings` : `${STATUS_TEXT[live.status]}: ${usd(live.amountCents)}`}</strong>
          <span className="muted">You chose: {live.description}{live.paypalStatus ? ` · PayPal ${live.paypalStatus}` : ''}</span>
          {live.error && <p className="error">{live.error}</p>}
        </div>
      </div>
    );
  }
  if (!item.savings.flexible) {
    return (
      <div className="empty">
        <Icon name="lock" size={18} />
        <span>You haven't marked <strong>{item.category}</strong> as a category you're willing to cut, so Budget Guardian won't suggest plans here. You can change that in Settings.</span>
      </div>
    );
  }
  if (!options.length) return <p className="muted" style={{ marginTop: 16 }}>No savings plans right now.</p>;

  const selected = options.find((o) => o.id === selectedId) ?? options[0];
  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: selected.id, expectedAmountCents: selected.savingsCents, confirm: true }),
      });
      onApproved(`${usd(selected.savingsCents)} is on its way to your savings`);
      onChanged({ poll: true });
    } catch (err) {
      setError(err.status === 409 ? `${err.message}. Refreshing with the new figures…` : `Not approved: ${err.message}`);
      if (err.status === 409) setTimeout(() => onChanged({}), 2500);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="plans">
      <p className="plans-title">{options.length > 1 ? 'Choose a plan' : 'Suggested plan'}</p>
      <div className="plan-grid" role="radiogroup" aria-label={`${item.category} savings plans`}>
        {options.map((o) => (
          <label key={o.id} className={`plan${o.id === selected.id ? ' selected' : ''}`}>
            <input type="radio" name={`plan-${item.category}`} checked={o.id === selected.id} onChange={() => { setSelectedId(o.id); setConfirming(false); setError(null); }} />
            <span className="radio" aria-hidden="true">{o.id === selected.id && <Icon name="check" size={12} />}</span>
            <div className="save">{usd(o.savingsCents)} <small>saved</small></div>
            <div className="name">{planName(item.category, o)}</div>
            {textById.get(o.id) && <p className="why">{textById.get(o.id)}</p>}
            <div className="chips">
              {chips(o).map((c) => <span key={c.text} className="chip">{c.icon && <Icon name={c.icon} size={12} />}{c.text}</span>)}
            </div>
          </label>
        ))}
      </div>

      <div className="plan-actions">
        {confirming ? (
          <>
            <p>Budget Guardian will send <strong>{usd(selected.savingsCents)}</strong> to your savings account through PayPal. Nothing else will happen.</p>
            <div className="actions">
              <button type="button" className="btn" disabled={busy} onClick={approve}>{busy ? 'Approving…' : `Yes, move ${usd(selected.savingsCents)}`}</button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => { setConfirming(false); setError(null); }}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <p><Icon name="lock" size={14} /> Approving moves the saved amount to savings. Nothing happens until you confirm.</p>
            <button type="button" className="btn" onClick={() => setConfirming(true)}>Approve plan · save {usd(selected.savingsCents)}</button>
          </>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
