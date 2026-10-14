import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import CategoryCard from './components/CategoryCard.jsx';
import { Header, Hero, Habits, Approvals, Preferences, PayPalPanel } from './components/Sections.jsx';

// Flexible categories that aren't spiking still get a card (e.g. entertainment's
// "skip subscriptions not billed yet").
async function loadAll() {
  const categories = await api('/api/categories');
  const flexible = categories.filter((c) => c.flexible).map((c) => c.category);
  const query = flexible.map((c) => `category=${encodeURIComponent(c)}`).join('&');
  const [advice, history, habits, approvals, paypalStatus, paypalTransactions] = await Promise.all([
    api(`/api/advice${query ? `?${query}` : ''}`),
    api('/api/history'),
    api('/api/habits'),
    api('/api/approvals'),
    api('/api/paypal/status'),
    api('/api/paypal/transactions'),
  ]);
  // Non-spiking cards only when they have something to approve.
  const others = advice.others.filter((o) => o.savings.options.some((x) => x.savingsCents > 0));
  return { categories, advice, history, habits: habits.habits, approvals, others, paypalStatus, paypalTransactions };
}

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async ({ poll } = {}) => {
    try {
      setData(await loadAll());
      setError(null);
    } catch (err) {
      setError(err.message);
    }
    // After an approval, check PayPal a few times until the payout settles.
    if (poll) {
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const list = await api('/api/approvals').catch(() => []);
        const pending = list.filter((a) => a.status === 'sent');
        await Promise.all(pending.map((a) => api(`/api/approvals/${a.id}`).catch(() => null)));
        if (!pending.length) break;
      }
      const next = await loadAll().catch(() => null);
      if (next) setData(next);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (error && !data) return <main className="app"><p className="skeleton">Could not load Budget Guardian: {error}</p></main>;
  if (!data) return <main className="app"><p className="skeleton">Checking this month's spending…</p></main>;

  const { advice, history, habits, approvals, categories, others, paypalStatus, paypalTransactions } = data;
  const historyFor = (category) => history.categories.find((c) => c.category === category);
  const savingsById = new Map([...advice.spikes, ...others].flatMap((s) => s.savings.options.map((o) => [o.id, o])));

  return (
    <main className="app">
      <Header month={advice.month} daysElapsed={advice.daysElapsed} daysInMonth={advice.daysInMonth} demo={advice.demo} asOf={advice.asOf} />
      <Hero spikes={advice.spikes} history={history} approvals={approvals} month={advice.month} savingsById={savingsById} />

      <h2 className="section">{advice.spikes.length ? 'Spending spikes' : 'This month'}</h2>
      <div className="stack">
        {advice.spikes.map((s) => (
          <CategoryCard key={s.category} item={s} history={historyFor(s.category)} approvals={approvals} month={advice.month} onChanged={refresh} />
        ))}
        {!advice.spikes.length && <div className="card"><p className="muted">No spikes this month. Nice.</p></div>}
      </div>

      {others.length > 0 && (
        <>
          <h2 className="section">Other ways to save this month</h2>
          <div className="stack">
            {others.map((o) => (
              <CategoryCard key={o.category} item={o} history={historyFor(o.category)} approvals={approvals} month={advice.month} onChanged={refresh} />
            ))}
          </div>
        </>
      )}

      <h2 className="section">Habits from past months</h2>
      <Habits habits={habits} />

      <h2 className="section">From your PayPal account</h2>
      <PayPalPanel status={paypalStatus} transactions={paypalTransactions} onChanged={refresh} />

      <h2 className="section">Your approvals</h2>
      <Approvals approvals={approvals} />

      <h2 className="section">Flexible categories</h2>
      <Preferences categories={categories} onChanged={refresh} />
    </main>
  );
}
