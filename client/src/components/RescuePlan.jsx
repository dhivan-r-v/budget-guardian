import { useState } from 'react';
import { api, usd } from '../api.js';
import { Icon, CategoryIcon } from './Icons.jsx';

// The planning agent's proposal for getting back under budget: which plans to combine, why,
// and the steps it took. Approving sends each plan through the normal approval.
export default function RescuePlan({ rescue, onChanged, onApproved }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState([]);

  if (rescue.status === 'covered') {
    return (
      <div className="callout ok" style={{ marginTop: 0 }}>
        <Icon name="check" size={18} />
        <span>The plans you approved cover this month's overspend of <strong>{usd(rescue.goal.overCents)}</strong>.</span>
      </div>
    );
  }
  if (rescue.status !== 'needed' || !rescue.plan.items.length) return null;

  const { goal, plan, trace, source } = rescue;
  const back = plan.afterCents <= 0;
  const items = plan.items.map((i) => ({ optionId: i.optionId, expectedAmountCents: i.savingsCents }));

  async function approveAll() {
    setBusy(true);
    setErrors([]);
    try {
      const results = await api('/api/rescue/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items, confirm: true }),
      });
      const failed = results.filter((r) => !r.ok);
      const moved = results.filter((r) => r.ok).reduce((s, r) => s + r.approval.amountCents, 0);
      if (moved) onApproved(`${usd(moved)} is on its way to your savings`);
      if (failed.length) setErrors(failed.map((r) => `${plan.items.find((i) => i.optionId === r.optionId)?.description ?? r.optionId}: ${r.error ?? r.approval?.error ?? 'not approved'}`));
      else setConfirming(false);
      onChanged({ poll: moved > 0 });
    } catch (err) {
      setErrors([err.message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card rescue" aria-label="Rescue plan">
      <div className="rescue-head">
        <p className="eyebrow"><Icon name="sparkle" size={14} />Rescue plan</p>
        <span className={`status-pill ${source === 'ai' ? 'ok' : 'neutral'}`} title={source === 'ai' ? 'Planned by the AI agent; every figure was calculated by code.' : 'Planned by rules while the AI agent is unavailable.'}>
          {source === 'ai' ? 'Planned by AI agent' : rescue.pending ? 'AI agent is planning…' : 'Planned by rules'}
        </span>
      </div>
      <h3 className="rescue-title">{back ? `Back under budget by ${usd(-plan.afterCents)}` : `${usd(plan.totalCents)} closer to your budget`}</h3>
      <p className="muted">
        You're heading {usd(goal.overCents)} over your {usd(goal.budgetCents)} budget{goal.committedCents > 0 && <>, and approved plans already cover {usd(goal.committedCents)}</>}.
      </p>
      <p className="rescue-summary">{plan.summary}</p>

      <ul className="rescue-items">
        {plan.items.map((i) => (
          <li key={i.optionId}>
            <CategoryIcon category={i.category} size={16} />
            <div className="grow">
              <div className="what">{i.description}</div>
              <div className="why">{i.why}</div>
            </div>
            <strong className="amount">{usd(i.savingsCents)}</strong>
          </li>
        ))}
        <li className="total">
          <span className="grow">Moved to savings in total</span>
          <strong className="amount">{usd(plan.totalCents)}</strong>
        </li>
        {!back && (
          <li className="left">
            <span className="grow">Still over budget after this plan</span>
            <strong className="amount">{usd(plan.afterCents)}</strong>
          </li>
        )}
      </ul>

      <details className="trace">
        <summary>How {source === 'ai' ? 'the agent' : 'this was'} planned this ({trace.length} steps)</summary>
        <ol>{trace.map((t, n) => <li key={n}>{t.text}</li>)}</ol>
      </details>

      <div className="plan-actions">
        {confirming ? (
          <>
            <p>Budget Guardian will send <strong>{plan.items.length === 1 ? 'one transfer' : `${plan.items.length} transfers`} totalling {usd(plan.totalCents)}</strong> to your savings through PayPal. Nothing else will happen.</p>
            <div className="actions">
              <button type="button" className="btn" disabled={busy} onClick={approveAll}>{busy ? 'Approving…' : `Yes, move ${usd(plan.totalCents)}`}</button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => { setConfirming(false); setErrors([]); }}>Cancel</button>
            </div>
          </>
        ) : (
          <>
            <p><Icon name="lock" size={14} /> You can also pick plans one category at a time below. Nothing moves until you confirm.</p>
            <button type="button" className="btn" onClick={() => setConfirming(true)}>Approve rescue plan · save {usd(plan.totalCents)}</button>
          </>
        )}
      </div>
      {errors.map((e) => <p key={e} className="error" role="alert">{e}</p>)}
    </section>
  );
}
