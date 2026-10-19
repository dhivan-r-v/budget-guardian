import { useCallback, useEffect, useRef, useState } from 'react';
import { api, monthLong } from './api.js';
import { Icon } from './components/Icons.jsx';
import CategoryCard from './components/CategoryCard.jsx';
import { SummaryCard, SavingsCard } from './components/Summary.jsx';
import { Habits, PayPalPanel } from './components/Feed.jsx';
import { BudgetSetting, Preferences, AlertsSetting } from './components/Settings.jsx';

// Flexible categories that aren't spiking still get a card when they have a plan
// (e.g. entertainment's "skip subscriptions not billed yet").
async function loadAll() {
  const categories = await api('/api/categories');
  const flexible = categories.filter((c) => c.flexible).map((c) => c.category);
  const query = flexible.map((c) => `category=${encodeURIComponent(c)}`).join('&');
  const [advice, history, habits, approvals, paypalStatus, paypalTransactions, budget, alerts] = await Promise.all([
    api(`/api/advice${query ? `?${query}` : ''}`),
    api('/api/history'),
    api('/api/habits'),
    api('/api/approvals'),
    api('/api/paypal/status'),
    api('/api/paypal/transactions'),
    api('/api/budget'),
    api('/api/alerts'),
  ]);
  const others = advice.others.filter((o) => o.savings.options.some((x) => x.savingsCents > 0));
  return { categories, advice, history, habits: habits.habits, approvals, others, paypalStatus, paypalTransactions, budget, alerts };
}

function Topbar({ advice }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" /><path d="M9 12l2 2 4-4" />
            </svg>
          </span>
          Budget Guardian
        </div>
        {advice && (
          <div className="month-chip">
            {monthLong(advice.month)} · day {advice.daysElapsed} of {advice.daysInMonth}
            <span className="month-track" aria-hidden="true"><span style={{ width: `${(advice.daysElapsed / advice.daysInMonth) * 100}%` }} /></span>
          </div>
        )}
        {advice?.demo && <span className="pill demo" title="Seeded demo history plus your PayPal sandbox transactions; no real money.">Sandbox demo</span>}
        <span className="pill"><Icon name="lock" size={13} />Nothing moves until you approve</span>
      </div>
    </header>
  );
}

function Skeleton() {
  const block = (h, w = '100%') => <div className="skel" style={{ height: h, width: w }} />;
  return (
    <div className="shell" aria-busy="true" aria-label="Loading">
      <div className="main">
        <div className="card stack">{block(38, '40%')}{block(16, '90%')}{block(16, '70%')}{block(200)}{block(90)}</div>
        <div className="card stack">{block(38, '40%')}{block(16, '80%')}{block(160)}</div>
      </div>
      <div className="side">
        <div className="card stack">{block(14, '50%')}{block(48, '70%')}{block(12)}{block(90)}</div>
        <div className="card stack">{block(14, '40%')}{block(32, '50%')}{block(120)}</div>
      </div>
    </div>
  );
}

const Section = ({ title, note, children }) => (
  <section>
    <div className="section-head"><h2>{title}</h2>{note && <span className="muted">{note}</span>}</div>
    {children}
  </section>
);

export default function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const settingsRef = useRef(null);

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
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  if (error && !data) {
    return (
      <>
        <Topbar />
        <div className="load-error card">Could not load Budget Guardian: {error}<br /><button type="button" className="btn" style={{ marginTop: 14 }} onClick={() => refresh()}>Try again</button></div>
      </>
    );
  }
  if (!data) return <><Topbar /><Skeleton /></>;

  const { advice, history, habits, approvals, categories, others, paypalStatus, paypalTransactions, budget, alerts } = data;
  const historyFor = (category) => history.categories.find((c) => c.category === category);
  const savingsById = new Map([...advice.spikes, ...others].flatMap((s) => s.savings.options.map((o) => [o.id, o])));
  const card = (item) => (
    <CategoryCard key={item.category} item={item} history={historyFor(item.category)} approvals={approvals} month={advice.month} onChanged={refresh} onApproved={setToast} />
  );

  return (
    <>
      <Topbar advice={advice} />
      <div className="shell">
        <aside className="side" aria-label="Your month">
          <SummaryCard budget={budget} spikes={advice.spikes} onSetBudget={() => settingsRef.current?.scrollIntoView({ behavior: 'smooth' })} />
          <SavingsCard approvals={approvals} month={advice.month} savingsById={savingsById} />
        </aside>

        <main className="main">
          <Section title={advice.spikes.length ? 'Needs your attention' : 'This month'} note={advice.spikes.length ? `${advice.spikes.length} spending spike${advice.spikes.length === 1 ? '' : 's'}` : null}>
            <div className="stack">
              {advice.spikes.map(card)}
              {!advice.spikes.length && <div className="card"><p className="muted">No category is heading well above its usual month. Nice.</p></div>}
            </div>
          </Section>

          {others.length > 0 && <Section title="More ways to save"><div className="stack">{others.map(card)}</div></Section>}

          <Section title="Habits from past months" note="small, frequent purchases"><Habits habits={habits} /></Section>

          <Section title="From your PayPal account"><PayPalPanel status={paypalStatus} transactions={paypalTransactions} onChanged={refresh} /></Section>

          <div ref={settingsRef}>
            <Section title="Settings">
              <div className="settings">
                <BudgetSetting key={budget.budgetCents ?? 'none'} budget={budget} onChanged={refresh} />
                <Preferences categories={categories} onChanged={refresh} />
                <AlertsSetting alerts={alerts} />
              </div>
            </Section>
          </div>
        </main>
      </div>
      <footer className="footer">
        <span>Budget Guardian · PayPal sandbox</span>
        <span>Amounts are calculated in code; AI only writes the words.</span>
        <a href="https://github.com/dhivan-r-v/budget-guardian">Source on GitHub</a>
      </footer>
      {toast && <div className="toast" role="status"><Icon name="check" size={18} className="draw" />{toast}</div>}
    </>
  );
}
