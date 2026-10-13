import express from 'express';
import { openDb } from './src/db.js';
import { detectSpikes } from './src/spikes.js';
import { explainSpikes } from './src/causes.js';
import { suggestSavings, suggestSavingsForSpikes, setFlexible } from './src/savings.js';
import { adviseCategory, adviseSpikes } from './src/advisor.js';
import { categorize, accuracy } from './src/categorizer.js';
import { habitInsights } from './src/habits.js';
import { monthlyHistory } from './src/history.js';
import { getAccessToken, paypal } from './src/paypal.js';
import { ApprovalError, approve, retry, refresh, getApproval, listApprovals } from './src/approvals.js';

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BASE_URL, PORT = 3000 } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_BASE_URL) {
  console.error('Missing PayPal settings. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const db = openDb();
const app = express();
app.use(express.json());
// The React dashboard's production build (npm run build).
app.use(express.static('client/dist'));

// For Render's health check: the server is up and the database answers.
app.get('/api/health', (req, res) => {
  db.prepare('SELECT 1').get();
  res.json({ ok: true, demoAsOf: process.env.DEMO_AS_OF?.trim() || null });
});

// Confirms the credentials work. Never returns the token itself.
app.get('/api/test-token', async (req, res, next) => {
  try {
    await getAccessToken();
    res.json({ ok: true, environment: PAYPAL_BASE_URL.includes('sandbox') ? 'sandbox' : 'live' });
  } catch (err) {
    next(err);
  }
});

app.post('/api/create-order', async (req, res, next) => {
  try {
    const amount = String(req.body?.amount ?? '10.00');
    if (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'amount must be a positive USD value like "10.00"' });
    }
    const order = await paypal('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: Number(amount).toFixed(2) } }],
    });
    const approveUrl = order.links.find((l) => l.rel === 'approve' || l.rel === 'payer-action')?.href;
    res.json({ id: order.id, status: order.status, approveUrl });
  } catch (err) {
    next(err);
  }
});

app.post('/api/capture-order/:orderId', async (req, res, next) => {
  try {
    const capture = await paypal('POST', `/v2/checkout/orders/${encodeURIComponent(req.params.orderId)}/capture`);
    res.json(capture);
  } catch (err) {
    next(err);
  }
});

// Builds the spike report from an optional ?asOf=YYYY-MM-DD (defaults to today).
// Sends a 400 and returns null on bad input.
function reportFor(req, res) {
  const { asOf } = req.query;
  if (asOf !== undefined && (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf))) {
    res.status(400).json({ error: 'asOf must be YYYY-MM-DD' });
    return null;
  }
  try {
    return detectSpikes(db, asOf ? { asOf } : {});
  } catch (err) {
    res.status(400).json({ error: err.message });
    return null;
  }
}

// Spikes with their causes and savings options.
app.get('/api/spikes', (req, res) => {
  const report = reportFor(req, res);
  if (report) res.json(suggestSavingsForSpikes(db, explainSpikes(db, report)));
});

// Savings options for one category, spiking or not: ?category=entertainment
app.get('/api/savings', (req, res) => {
  const report = reportFor(req, res);
  if (!report) return;
  const entry = report.categories.find((c) => c.category === req.query.category);
  if (!entry) return res.status(404).json({ error: `no spending found in category "${req.query.category}"` });
  res.json(suggestSavings(db, report, entry));
});

// Friendly advice for every spike: cause, savings options and AI-written text (or a
// code-written fallback). Add ?category=entertainment to also get a non-spiking category.
app.get('/api/advice', async (req, res, next) => {
  const report = reportFor(req, res);
  if (!report) return;
  try {
    // The dashboard never waits for the LLM: uncached text arrives on a later load.
    const result = await adviseSpikes(db, report, { wait: false });
    const extra = [req.query.category ?? []].flat().filter((c) => !report.spikes.some((s) => s.category === c));
    const others = [];
    for (const category of extra) {
      const entry = report.categories.find((c) => c.category === category);
      if (entry) others.push({ ...entry, ...(await adviseCategory(db, report, entry, { wait: false })) });
    }
    res.json({ ...result, others });
  } catch (err) {
    next(err);
  }
});

// --- Approvals: the only way money moves.
// Body: { optionId, expectedAmountCents, confirm: true, asOf? }. The server recomputes the
// amount and refuses if it differs from what the user saw.
const approvalRoute = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (err) {
    if (err instanceof ApprovalError) return res.status(err.status).json({ error: err.message, details: err.details });
    next(err);
  }
};

app.post('/api/approvals', approvalRoute(async (req, res) => {
  const { optionId, expectedAmountCents, confirm, asOf } = req.body ?? {};
  if (confirm !== true) throw new ApprovalError(400, 'approval must be confirmed by the user (confirm: true)');
  if (asOf !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(asOf))) throw new ApprovalError(400, 'asOf must be YYYY-MM-DD');
  const { approval, duplicate } = await approve(db, { optionId, expectedAmountCents, asOf });
  res.status(duplicate ? 200 : 201).json({ ...approval, duplicate });
}));

app.get('/api/approvals', (req, res) => res.json(listApprovals(db)));

// Returns the approval, first refreshing a sent payout's status from PayPal.
app.get('/api/approvals/:id', approvalRoute(async (req, res) => {
  if (!getApproval(db, req.params.id)) throw new ApprovalError(404, 'approval not found');
  res.json(await refresh(db, req.params.id));
}));

app.post('/api/approvals/:id/retry', approvalRoute(async (req, res) => {
  res.json(await retry(db, req.params.id));
}));

// Monthly totals per category for the dashboard charts.
app.get('/api/history', (req, res) => {
  const report = reportFor(req, res);
  if (report) res.json(monthlyHistory(db, report));
});

// Small, frequent purchases from past months in flexible categories, with cut-back savings.
app.get('/api/habits', (req, res) => {
  const report = reportFor(req, res);
  if (report) res.json({ asOf: report.asOf, baselineMonths: report.baselineMonths, habits: habitInsights(db, report) });
});

// Labels uncategorized transactions with the LLM. Safe to call repeatedly: only
// unlabeled transactions are sent, and failures leave them for the next call.
// Spends LLM quota, so on a public deployment (ADMIN_TOKEN set) it needs that token.
app.post('/api/categorize', async (req, res, next) => {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (token && req.get('Authorization') !== `Bearer ${token}`) return res.status(401).json({ error: 'admin token required' });
  try {
    res.json({ ...(await categorize(db)), accuracy: accuracy(db) });
  } catch (err) {
    next(err);
  }
});

// Every category seen in transactions, with whether the user marked it flexible.
app.get('/api/categories', (req, res) => {
  res.json(
    db
      .prepare(`
        SELECT DISTINCT COALESCE(t.category, t.seed_category) AS category, COALESCE(p.flexible, 0) AS flexible
        FROM transactions t
        LEFT JOIN category_prefs p ON p.category = COALESCE(t.category, t.seed_category)
        WHERE COALESCE(t.category, t.seed_category) IS NOT NULL
        ORDER BY 1
      `)
      .all()
      .map((r) => ({ category: r.category, flexible: Boolean(r.flexible) })),
  );
});

// The user marks a category as flexible (willing to cut) or not: { "flexible": true }
app.put('/api/categories/:category', (req, res) => {
  if (typeof req.body?.flexible !== 'boolean') return res.status(400).json({ error: 'flexible must be true or false' });
  setFlexible(db, req.params.category, req.body.flexible);
  res.json({ category: req.params.category, flexible: req.body.flexible });
});

app.use((err, req, res, next) => {
  console.error(err.message, err.details ?? '');
  res.status(err.status ?? 500).json({ error: err.message, details: err.details });
});

app.listen(PORT, () => console.log(`Budget Guardian server on http://localhost:${PORT}`));
