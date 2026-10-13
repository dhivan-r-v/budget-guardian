import { capitalize } from '../api.js';
import SpendingChart from './SpendingChart.jsx';
import CauseBar from './CauseBar.jsx';
import Options from './Options.jsx';

// One category: AI-written (or code-written) summary, the monthly chart, the cause
// breakdown for a spike, and the savings options to approve.
export default function CategoryCard({ item, history, approvals, month, onChanged }) {
  const { advice } = item;
  return (
    <article className="card">
      <span className={`tag${item.isSpike ? ' spike' : ''}`}>
        <span className="dot" />
        {capitalize(item.category)}{item.isSpike ? ' · spending spike' : ''}
      </span>
      <h3>{advice.headline}</h3>
      <p className="lede">{advice.explanation}</p>
      {history && <SpendingChart category={item.category} history={history} />}
      {item.isSpike && item.cause && <CauseBar cause={item.cause} />}
      <Options item={item} approvals={approvals} month={month} onChanged={onChanged} />
      <p className="fineprint">
        {advice.source === 'ai' ? 'Written by AI from figures computed by Budget Guardian. ' : 'Written by Budget Guardian. '}
        Every amount is calculated in code, never by the AI.
      </p>
    </article>
  );
}
