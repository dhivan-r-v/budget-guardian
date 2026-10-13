import { useState } from 'react';
import { usd } from '../api.js';

// What the increase is made of: more purchases, higher prices, subscription changes.
// The parts add up exactly to the increase (computed server-side).
export default function CauseBar({ cause }) {
  const [hover, setHover] = useState(null);
  const o = cause.oneOff;
  const parts = [
    { key: 'often', label: `More purchases (${o.count} so far vs ${o.expectedCount} usual by now)`, cents: o.moreOftenCents, color: 'var(--series-1)' },
    { key: 'price', label: `Higher prices (${usd(o.averageAmountCents)} avg vs ${usd(o.usualAmountCents)})`, cents: o.higherPricesCents, color: 'var(--series-2)' },
    { key: 'subs', label: 'Subscription changes', cents: cause.recurring.excessCents, color: 'var(--series-3)' },
  ].filter((p) => p.cents > 0);
  const total = parts.reduce((s, p) => s + p.cents, 0);
  if (!total) return null;

  return (
    <div className="cause">
      <p className="cause-title">Why it's up {usd(cause.increaseCents)}</p>
      <div className="cause-bar" role="img" aria-label={parts.map((p) => `${p.label}: ${usd(p.cents)}`).join('; ')}>
        {parts.map((p) => (
          <span
            key={p.key}
            style={{ width: `${(p.cents / total) * 100}%`, background: p.color, opacity: hover && hover !== p.key ? 0.45 : 1 }}
            onMouseEnter={() => setHover(p.key)}
            onMouseLeave={() => setHover(null)}
            title={`${p.label}: ${usd(p.cents)}`}
          />
        ))}
      </div>
      <ul className="legend">
        {parts.map((p) => (
          <li key={p.key}>
            <span className="swatch" style={{ background: p.color }} />
            {p.label}: <strong>{usd(p.cents)}</strong>
          </li>
        ))}
      </ul>
      {cause.largePurchases.length > 0 && (
        <p className="muted">Large purchase: {cause.largePurchases.map((t) => `${t.merchant} ${usd(t.amountCents)} on ${t.date}`).join(', ')}</p>
      )}
      {cause.recurring.newSubscriptions.length > 0 && (
        <p className="muted">New subscription: {cause.recurring.newSubscriptions.map((t) => `${t.merchant} ${usd(t.amountCents)}`).join(', ')}</p>
      )}
    </div>
  );
}
