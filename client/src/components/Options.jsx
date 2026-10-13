import { useState } from 'react';
import { api, usd, STATUS_TEXT } from '../api.js';

// One savings option: an Approve button, an in-page confirmation, then the approval status.
// The server recomputes the amount; a 409 means the figures changed and the page refreshes.
function Option({ category, text, option, live, onChanged }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function approve() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: option.id, expectedAmountCents: option.savingsCents, confirm: true }),
      });
      setConfirming(false);
      onChanged({ poll: true });
    } catch (err) {
      setError(err.status === 409 ? `${err.message}. Refreshing with the new figures…` : `Not approved: ${err.message}`);
      if (err.status === 409) setTimeout(() => onChanged({}), 2500);
    } finally {
      setBusy(false);
    }
  }

  const chips = [];
  if (option.co2AvoidedKg) chips.push(`${option.co2AvoidedKg} kg CO2 avoided`);
  if (option.transitCostCents) chips.push(`after ${usd(option.transitCostCents)} in fares`);
  if (option.type === 'skip_subscriptions') {
    const billed = option.subscriptions.filter((s) => s.chargedThisMonth).map((s) => s.merchant);
    if (billed.length) chips.push(`${billed.join(', ')} already billed`);
  }

  let action;
  if (live?.optionId === option.id) {
    action = <span className={`status ${live.status}`}>{live.status === 'completed' ? '✓ ' : ''}{STATUS_TEXT[live.status]} · {usd(live.amountCents)}</span>;
  } else if (live) {
    action = <span className="muted">You chose another {category} plan this month</span>;
  } else if (option.savingsCents > 0 && !confirming) {
    action = <button type="button" className="btn" onClick={() => setConfirming(true)}>Approve · save {usd(option.savingsCents)}</button>;
  }

  return (
    <div className="option">
      <div className="option-text">
        {text}
        {chips.length > 0 && <div className="option-meta">{chips.map((c) => <span key={c} className="chip">{c}</span>)}</div>}
      </div>
      {action}
      {confirming && !live && (
        <div className="confirm" role="group" aria-label="Confirm approval">
          <p>Budget Guardian will send <strong>{usd(option.savingsCents)}</strong> to your savings account through PayPal. Nothing else will happen.</p>
          <div className="actions">
            <button type="button" className="btn" disabled={busy} onClick={approve}>{busy ? 'Approving…' : `Yes, move ${usd(option.savingsCents)} to savings`}</button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => { setConfirming(false); setError(null); }}>Cancel</button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

export default function Options({ item, approvals, month, onChanged }) {
  const byId = new Map(item.savings.options.map((o) => [o.id, o]));
  const live = approvals.find((a) => a.category === item.category && a.month === month && a.status !== 'failed');
  const rows = item.advice.options.filter((o) => byId.has(o.id));
  if (!rows.length) return <p className="muted">No savings options right now.</p>;
  return (
    <div className="options">
      {rows.map((o) => (
        <Option key={o.id} category={item.category} text={o.text} option={byId.get(o.id)} live={live} onChanged={onChanged} />
      ))}
    </div>
  );
}
