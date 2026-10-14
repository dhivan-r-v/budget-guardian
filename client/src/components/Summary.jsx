import { usd, STATUS_TEXT } from '../api.js';
import { Icon } from './Icons.jsx';
import { CountUp } from './Motion.jsx';

function Meter({ budget }) {
  const total = Math.max(budget.budgetCents, budget.spentCents + budget.upcomingRecurringCents);
  const pct = (c) => `${Math.max(0, (c / total) * 100)}%`;
  const today = (budget.monthElapsedPct / 100) * (budget.budgetCents / total) * 100;
  return (
    <div className="meter-wrap">
      <div className="meter" role="img" aria-label={`Spent ${usd(budget.spentCents)} and ${usd(budget.upcomingRecurringCents)} in bills still to come, of a ${usd(budget.budgetCents)} budget. ${Math.round(budget.monthElapsedPct)}% of the month has passed.`}>
        <div className="meter-fill">
          <span style={{ width: pct(budget.spentCents), background: 'var(--series-1)' }} />
          {budget.upcomingRecurringCents > 0 && <span style={{ width: pct(budget.upcomingRecurringCents), background: 'var(--series-1-soft)' }} />}
        </div>
      </div>
      <i className="today" style={{ left: `${today}%` }} aria-hidden="true" />
    </div>
  );
}

function Outlook({ budget, top }) {
  const over = budget.projectedVsBudgetCents;
  if (over > 0) {
    return (
      <div className="callout warn">
        <Icon name="alert" size={18} />
        <span>
          Heading <strong>{usd(over)} over</strong> budget by month end.
          {budget.spikesCauseOverspend && top && <> The <strong>{top.category}</strong> spike (+{usd(top.increaseCents)}) is why; without it you'd finish under.</>}
        </span>
      </div>
    );
  }
  return (
    <div className="callout ok">
      <Icon name="check" size={18} />
      <span>On track to finish <strong>{usd(-over)} under</strong> budget.</span>
    </div>
  );
}

// The headline: what's safe to spend for the rest of the month.
export function SummaryCard({ budget, spikes, onSetBudget }) {
  const top = spikes[0];
  if (!budget.set) {
    return (
      <section className="card summary" aria-label="This month">
        <p className="eyebrow">This month so far</p>
        <p className="hero-figure">{usd(budget.spentCents)}</p>
        <p className="hero-sub">spent, heading for {usd(budget.projectedCents)} (usual month {usd(budget.usualCents)}).</p>
        <div className="callout ok"><Icon name="wallet" size={18} /><span>Set a monthly budget to see what's safe to spend each day.</span></div>
        <button type="button" className="btn" style={{ marginTop: 14 }} onClick={onSetBudget}>Set a budget</button>
      </section>
    );
  }
  return (
    <section className="card summary" aria-label="Safe to spend">
      <p className="eyebrow">Safe to spend · {budget.daysLeft} day{budget.daysLeft === 1 ? '' : 's'} left</p>
      <p className="hero-figure"><CountUp value={Math.max(0, budget.safeToSpendCents)} format={usd} /></p>
      <p className="hero-sub">About <strong>{usd(budget.perDayCents)} a day</strong> of your {usd(budget.budgetCents)} monthly budget</p>
      <Meter budget={budget} />
      <div className="rows">
        <div className="row"><span className="key"><span className="swatch" style={{ background: 'var(--series-1)' }} />Spent</span><strong>{usd(budget.spentCents)} · {Math.round(budget.spentPct)}%</strong></div>
        <div className="row"><span className="key"><span className="swatch" style={{ background: 'var(--series-1-soft)' }} />Bills still to come</span><strong>{usd(budget.upcomingRecurringCents)}</strong></div>
        <div className="row"><span className="key"><span className="swatch line" style={{ background: 'var(--ink)' }} />Month passed</span><strong>{Math.round(budget.monthElapsedPct)}%</strong></div>
        <div className="row"><span className="key">Projected month</span><strong>{usd(budget.projectedCents)}</strong></div>
      </div>
      <Outlook budget={budget} top={top} />
    </section>
  );
}

const when = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};

// Money moved to savings, CO2 avoided, and every approval as a timeline.
export function SavingsCard({ approvals, month, savingsById }) {
  const thisMonth = approvals.filter((a) => a.month === month && a.status !== 'failed');
  const saved = thisMonth.reduce((s, a) => s + a.amountCents, 0);
  const co2 = thisMonth.reduce((s, a) => s + (savingsById.get(a.optionId)?.co2AvoidedKg ?? 0), 0);
  return (
    <section className="card" aria-label="Savings">
      <p className="eyebrow muted">Moved to savings this month</p>
      <p className="savings-figure"><CountUp value={saved} format={usd} /></p>
      <div className="mini-stats">
        <div className="mini-stat"><div className="label"><Icon name="check" size={12} />Plans approved</div><div className="value">{thisMonth.length}</div></div>
        <div className="mini-stat"><div className="label"><Icon name="leaf" size={12} />CO2 avoided</div><div className="value">{Math.round(co2 * 10) / 10} kg</div></div>
      </div>
      {approvals.length ? (
        <ol className="timeline" aria-label="Approvals">
          {approvals.slice(0, 6).map((a) => (
            <li key={a.id}>
              <span className={`dot ${a.status}`}><Icon name={a.status === 'completed' ? 'check' : a.status === 'failed' ? 'alert' : 'refresh'} size={12} /></span>
              <div>
                <div className="what">{a.description}</div>
                <div className="when">{when(a.createdAt)} · {STATUS_TEXT[a.status]}</div>
                {a.error && <div className="error">{a.error}</div>}
              </div>
              <span className="amount">{usd(a.amountCents)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted" style={{ marginTop: 12 }}>No approvals yet. Nothing moves until you approve a plan.</p>
      )}
    </section>
  );
}
