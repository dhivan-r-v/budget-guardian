import { usd, STATUS_TEXT, PLAN_STATUS } from '../api.js';
import { Icon } from './Icons.jsx';
import { CountUp, useTilt } from './Motion.jsx';
import { monthShort } from '../api.js';

function Meter({ budget }) {
  const total = Math.max(budget.budgetCents, budget.spentCents + budget.upcomingRecurringCents);
  const pct = (c) => `${Math.max(0, (c / total) * 100)}%`;
  const today = (budget.monthElapsedPct / 100) * (budget.budgetCents / total) * 100;
  return (
    <div className="meter-wrap">
      <div className="meter" role="img" aria-label={`Spent ${usd(budget.spentCents)} and ${usd(budget.upcomingRecurringCents)} in bills still to come, of a ${usd(budget.budgetCents)} budget. ${Math.round(budget.monthElapsedPct)}% of the month has passed.`}>
        <div className="meter-fill">
          <span style={{ width: pct(budget.spentCents), background: 'var(--meter-spent, var(--series-1))' }} />
          {budget.upcomingRecurringCents > 0 && <span style={{ width: pct(budget.upcomingRecurringCents), background: 'var(--meter-bills, var(--series-1-soft))' }} />}
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

// The shield, as on the card.
const Emblem = () => (
  <span className="vault-emblem" aria-hidden="true">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" />
    </svg>
  </span>
);

// The headline, as a dark metal card: what's safe to spend for the rest of the month.
// It tilts toward the pointer; everything on it is also in plain text for screen readers.
export function SummaryCard({ budget, spikes, month, onSetBudget }) {
  const top = spikes[0];
  const tilt = useTilt();
  const foot = (
    <div className="vault-foot" aria-hidden="true">
      <span className="vault-chip" />
      <span>Budget Guardian · {monthShort(month)}</span>
    </div>
  );
  if (!budget.set) {
    return (
      <section className="vault" aria-label="This month">
        <div className="vault-card" ref={tilt}>
          <span className="vault-sheen" aria-hidden="true" />
          <div className="vault-top"><span className="vault-label">This month so far</span><Emblem /></div>
          <p className="vault-figure"><CountUp value={budget.spentCents} format={usd} /></p>
          <p className="vault-sub">spent, heading for <strong>{usd(budget.projectedCents)}</strong> (usual month {usd(budget.usualCents)})</p>
          <button type="button" className="btn" style={{ marginTop: 18 }} onClick={onSetBudget}>Set a budget</button>
          {foot}
        </div>
        <div className="callout ok"><Icon name="wallet" size={18} /><span>Set a monthly budget to see what's safe to spend each day.</span></div>
      </section>
    );
  }
  return (
    <section className="vault" aria-label="Safe to spend">
      <div className="vault-card" ref={tilt}>
        <span className="vault-sheen" aria-hidden="true" />
        <div className="vault-top"><span className="vault-label">Safe to spend · {budget.daysLeft} day{budget.daysLeft === 1 ? '' : 's'} left</span><Emblem /></div>
        <p className="vault-figure"><CountUp value={Math.max(0, budget.safeToSpendCents)} format={usd} ms={900} /></p>
        <p className="vault-sub">About <strong>{usd(budget.perDayCents)} a day</strong> of your {usd(budget.budgetCents)} monthly budget</p>
        <Meter budget={budget} />
        <div className="rows">
          <div className="row"><span className="key"><span className="swatch" style={{ background: 'var(--meter-spent)' }} />Spent</span><strong>{usd(budget.spentCents)} · {Math.round(budget.spentPct)}%</strong></div>
          <div className="row"><span className="key"><span className="swatch" style={{ background: 'var(--meter-bills)' }} />Bills still to come</span><strong>{usd(budget.upcomingRecurringCents)}</strong></div>
          <div className="row"><span className="key"><span className="swatch line" style={{ background: 'var(--vault-ink)' }} />Month passed</span><strong>{Math.round(budget.monthElapsedPct)}%</strong></div>
          <div className="row"><span className="key">Projected month</span><strong>{usd(budget.projectedCents)}</strong></div>
        </div>
        {foot}
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
      <p className="eyebrow">Moved to savings this month</p>
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
                <div className="when">{when(a.createdAt)} · {STATUS_TEXT[a.status]}{a.followThrough && <> · <span className={`plan-tag ${PLAN_STATUS[a.followThrough.status].tone}`}>{PLAN_STATUS[a.followThrough.status].text}</span></>}</div>
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
