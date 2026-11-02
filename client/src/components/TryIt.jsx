import { useState } from 'react';
import { Icon } from './Icons.jsx';

const KEY = 'bg-try-it-dismissed';
const readDismissed = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

const STEPS = [
  { to: 'attention', title: 'See why spending spiked', text: 'Each spike shows its cause, worked out in code, and an AI-written explanation.' },
  { to: 'attention', title: 'Approve the rescue plan', text: 'The AI agent plans how to get back under budget. Approving moves real sandbox money with PayPal Payouts.' },
  { to: 'paypal', title: 'Check your PayPal account', text: 'Spending is read from PayPal, and the balance is checked before any money moves.' },
  { to: 'banks', title: 'Add a card', text: 'Upload the sample card statement, or connect a test bank with Plaid (login user_transactions_dynamic, any password).' },
  { to: 'settings', title: 'Get alerts on your phone', text: 'Turn on alerts in Settings, and spikes arrive as notifications.' },
];

// A short guided tour for first-time visitors (judges included). Dismissible; remembered
// in this browser only.
export default function TryIt() {
  const [hidden, setHidden] = useState(readDismissed);
  if (hidden) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // Private mode: it just shows again next time.
    }
    setHidden(true);
  };
  const go = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <section className="card try-it" aria-label="Try it">
      <div className="rescue-head">
        <p className="eyebrow"><Icon name="sparkle" size={14} />Try it in two minutes</p>
        <button type="button" className="linkish" onClick={dismiss}>Hide</button>
      </div>
      <ol className="try-steps">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <button type="button" onClick={() => go(s.to)}>
              <span className="try-n" aria-hidden="true">{i + 1}</span>
              <span><strong>{s.title}</strong><span className="muted">{s.text}</span></span>
            </button>
          </li>
        ))}
      </ol>
      <p className="muted" style={{ marginTop: 12 }}>This is your own copy of the demo, with no real money involved. Start over anytime from Settings.</p>
    </section>
  );
}
