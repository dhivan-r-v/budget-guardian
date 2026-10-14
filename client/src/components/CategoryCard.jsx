import { capitalize, usd } from '../api.js';
import { CategoryIcon, Icon } from './Icons.jsx';
import SpendingChart from './SpendingChart.jsx';
import CauseBar from './CauseBar.jsx';
import PlanPicker from './PlanPicker.jsx';

// One category: status, the AI-written (or code-written) summary, key figures, the monthly
// chart, the cause breakdown for a spike, and the plans to choose from.
export default function CategoryCard({ item, history, approvals, month, onChanged, onApproved }) {
  const { advice } = item;
  const pct = item.increasePct === null ? null : Math.round(item.increasePct);
  const pill = item.isSpike
    ? <span className="status-pill spike"><Icon name="trend" size={13} />Spike{pct !== null ? ` · +${pct}%` : ''}</span>
    : item.increaseCents > 0
      ? <span className="status-pill neutral">A little above usual</span>
      : <span className="status-pill ok">On track</span>;
  return (
    <article className="card">
      <div className="card-head">
        <CategoryIcon category={item.category} />
        <div className="grow">
          <h3>{capitalize(item.category)}</h3>
          <span className="muted">{advice.headline}</span>
        </div>
        {pill}
      </div>
      <p className="lede">{advice.explanation}</p>
      <span className="byline">
        <Icon name={advice.source === 'ai' ? 'sparkle' : 'check'} size={13} />
        {advice.source === 'ai' ? 'Written by AI · every amount calculated in code' : 'Written by Budget Guardian'}
      </span>

      <div className="kpis">
        <div className="kpi"><div className="label">Spent so far</div><div className="value">{usd(item.currentCents)}</div></div>
        <div className="kpi"><div className="label">Projected month</div><div className={`value${item.isSpike ? ' bad' : ''}`}>{usd(item.projectedCents)}</div></div>
        <div className="kpi"><div className="label">Usual month</div><div className="value">{usd(item.baselineAvgCents)}</div></div>
      </div>

      {history && <SpendingChart category={item.category} history={history} />}
      {item.isSpike && item.cause && <CauseBar cause={item.cause} />}
      <PlanPicker item={item} approvals={approvals} month={month} onChanged={onChanged} onApproved={onApproved} />
    </article>
  );
}
