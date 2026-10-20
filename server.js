import express from 'express';
import { openDb } from './src/db.js';
import { detectSpikes } from './src/spikes.js';
import { explainSpikes } from './src/causes.js';
import { suggestSavings, suggestSavingsForSpikes, setFlexible } from './src/savings.js';
import { adviseCategory, adviseSpikes } from './src/advisor.js';
import { categorize, accuracy, labelByRules } from './src/categorizer.js';
import { habitInsights } from './src/habits.js';
import { monthlyHistory } from './src/history.js';
import { budgetStatus, setBudget } from './src/budget.js';
import { syncPayPal, syncStatus } from './src/paypalSync.js';
import { seedDemoIfStale } from './src/seed.js';
import { today } from './src/spikes.js';
import { getAccessToken, paypal } from './src/paypal.js';
import { ApprovalError, approve, retry, refresh, getApproval, listApprovals, withFollowThrough } from './src/approvals.js';
import { rescuePlan, approveRescue } from './src/rescue.js';
import { StatementError, previewStatement, importStatement, listImports, removeImport, sampleStatement } from './src/statements.js';
import { vapidKeys, subscribe, unsubscribe, isSubscribed, pushSender, runAlerts, listAlerts, deviceCount } from './src/alerts.js';

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BASE_URL, PORT = 3000 } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_BASE_URL) {
  console.error('Missing PayPal settings. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const db = openDb();
const app = express();
// Statements are uploaded as text inside JSON, up to 1 MB.
app.use(express.json({ limit: '2mb' }));
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
  res.status(duplicate ? 200 : 201).json({ ...withFollowThrough(db, approval), duplicate });
}));

// Each approval with how the user is doing on its plan (followThrough).
app.get('/api/approvals', (req, res) => res.json(listApprovals(db).map((a) => withFollowThrough(db, a))));

// Returns the approval, first refreshing a sent payout's status from PayPal.
app.get('/api/approvals/:id', approvalRoute(async (req, res) => {
  if (!getApproval(db, req.params.id)) throw new ApprovalError(404, 'approval not found');
  res.json(withFollowThrough(db, await refresh(db, req.params.id)));
}));

app.post('/api/approvals/:id/retry', approvalRoute(async (req, res) => {
  res.json(withFollowThrough(db, await retry(db, req.params.id)));
}));

// --- Rescue plan: the planning agent's proposal for getting back under budget.
// Never waits for the agent: the rules plan is returned until the agent's plan is ready.
app.get('/api/rescue', async (req, res, next) => {
  const report = reportFor(req, res);
  if (!report) return;
  try {
    res.json(await rescuePlan(db, report, { wait: false }));
  } catch (err) {
    next(err);
  }
});

// Approves every plan in the rescue plan: { items: [{ optionId, expectedAmountCents }], confirm: true }.
// Each goes through the normal approval (amount rechecked, balance checked).
app.post('/api/rescue/approve', approvalRoute(async (req, res) => {
  if (req.body?.confirm !== true) throw new ApprovalError(400, 'approval must be confirmed by the user (confirm: true)');
  const results = await approveRescue(db, req.body.items);
  res.json(results.map((r) => (r.approval ? { ...r, approval: withFollowThrough(db, r.approval) } : r)));
}));

// --- Device alerts (Web Push). New alerts go out after each sync.
app.get('/api/alerts', (req, res) => {
  res.json({ publicKey: vapidKeys(db).publicKey, devices: deviceCount(db), alerts: listAlerts(db) });
});

// A browser turned alerts on: { subscription } from PushManager.subscribe(). It gets this
// month's current alerts right away.
app.post('/api/alerts/subscribe', async (req, res, next) => {
  try {
    subscribe(db, req.body?.subscription);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    const result = await runAlerts(db, detectSpikes(db), { only: req.body.subscription.endpoint });
    res.json({ ok: true, delivered: result.sent });
  } catch (err) {
    next(err);
  }
});

app.post('/api/alerts/unsubscribe', (req, res) => {
  if (typeof req.body?.endpoint !== 'string') return res.status(400).json({ error: 'endpoint is required' });
  unsubscribe(db, req.body.endpoint);
  res.json({ ok: true });
});

// Sends a test alert to the one device asking. At most one a minute per device.
const lastTest = new Map();
app.post('/api/alerts/test', async (req, res, next) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string' || !isSubscribed(db, endpoint)) return res.status(404).json({ error: 'alerts are not on for this device' });
  if (Date.now() - (lastTest.get(endpoint) ?? 0) < 60_000) return res.status(429).json({ error: 'a test alert was sent less than a minute ago' });
  lastTest.set(endpoint, Date.now());
  try {
    const sub = db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
    await pushSender(db)(sub, { title: 'Budget Guardian alerts are on', body: "You'll get an alert here when a category starts spiking or a plan goes off track.", tag: 'test', url: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// The monthly budget: safe to spend, per day, and whether spikes push the month over.
app.get('/api/budget', (req, res) => {
  const report = reportFor(req, res);
  if (report) res.json(budgetStatus(db, report));
});

// The user sets their monthly budget: { "monthlyCents": 110000 }
app.put('/api/budget', (req, res) => {
  try {
    setBudget(db, req.body?.monthlyCents);
  } catch (err) {
    if (err instanceof RangeError) return res.status(400).json({ error: err.message });
    throw err;
  }
  const report = reportFor(req, res);
  if (report) res.json(budgetStatus(db, report));
});

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

// --- Statement upload: spending from any bank or card, from its CSV statement.
const statementRoute = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (err) {
    if (err instanceof StatementError) return res.status(err.status).json({ error: err.message, details: err.details });
    next(err);
  }
};

// Labels newly imported purchases (the LLM first, then name rules for what it couldn't),
// then checks for new spikes. In the background: the dashboard polls the import list.
let labeling = null;
function labelImported() {
  labeling ??= categorize(db)
    .catch((err) => console.error('Labeling imported purchases failed:', err.message))
    .then(() => labelByRules(db))
    .then(() => runAlerts(db, detectSpikes(db)))
    .catch((err) => console.error('Alerts after import failed:', err.message))
    .finally(() => { labeling = null; });
  return labeling;
}

// { text, layout? } -> the layout (read by the AI, or rules) and what would be imported.
app.post('/api/statements/preview', statementRoute(async (req, res) => {
  res.json(await previewStatement(db, { text: req.body?.text, layout: req.body?.layout }));
}));

// { text, layout, filename } -> imports the purchases with the layout the user previewed.
app.post('/api/statements/import', statementRoute(async (req, res) => {
  const result = importStatement(db, { text: req.body?.text, layout: req.body?.layout, filename: req.body?.filename });
  if (result.added) labelImported();
  res.status(result.added ? 201 : 200).json(result);
}));

app.get('/api/statements', (req, res) => res.json({ imports: listImports(db), labeling: Boolean(labeling) }));

app.delete('/api/statements/:id', statementRoute(async (req, res) => {
  res.json(removeImport(db, req.params.id));
}));

// A sample card statement ending today, to try the upload with.
app.get('/api/statements/sample.csv', (req, res) => {
  res.type('text/csv').attachment('sample-card-statement.csv').send(sampleStatement());
});

// --- PayPal sync: pull new transactions, label new merchants, keep the demo current.
// Runs at startup and every SYNC_INTERVAL_MINUTES (default 15); the dashboard can also ask.
let syncing = null;
async function runSync() {
  syncing ??= (async () => {
    // DEMO_ROLLING: the seeded history is regenerated to end today when a new day starts,
    // so a long-running demo always has a current month. PayPal rows are never touched.
    if (process.env.DEMO_ROLLING === '1') seedDemoIfStale(db, { end: today() });
    const result = await syncPayPal(db);
    // Label new merchants: the LLM first, then name rules for obvious PayPal merchants.
    const labels = await categorize(db).catch((err) => ({ errors: [err.message] }));
    const byRules = labelByRules(db);
    // Alerts last, so they see the newly labeled transactions.
    const alerts = await runAlerts(db, detectSpikes(db)).catch((err) => ({ error: err.message }));
    return { ...result, labeledByAi: labels.labeledTransactions ?? 0, labeledByRules: byRules, alerts };
  })().finally(() => { syncing = null; });
  return syncing;
}

app.get('/api/paypal/status', (req, res) => res.json({ ...syncStatus(db), syncing: Boolean(syncing) }));

// The most recent spending that came from PayPal (not the seeded history).
app.get('/api/paypal/transactions', (req, res) => {
  res.json(
    db.prepare(`
      SELECT id, occurred_at AS occurredAt, merchant, description, amount_cents AS amountCents,
             COALESCE(category, seed_category) AS category
      FROM transactions WHERE source = 'paypal' ORDER BY occurred_at DESC LIMIT 10
    `).all(),
  );
});

// Sync now. Throttled: at most once every 30 seconds.
app.post('/api/paypal/sync', async (req, res, next) => {
  const last = syncStatus(db).lastSyncAt;
  if (!syncing && last && Date.now() - Date.parse(last) < 30_000) {
    return res.status(429).json({ error: 'synced less than 30 seconds ago', status: syncStatus(db) });
  }
  try {
    const result = await runSync();
    res.json({ result, status: syncStatus(db) });
  } catch (err) {
    next(err);
  }
});

const SYNC_MINUTES = Number(process.env.SYNC_INTERVAL_MINUTES ?? 15);
const background = () => runSync().catch((err) => console.error('PayPal sync failed:', err.message));
if (SYNC_MINUTES > 0) setInterval(background, SYNC_MINUTES * 60_000).unref();

app.use((err, req, res, next) => {
  console.error(err.message, err.details ?? '');
  res.status(err.status ?? 500).json({ error: err.message, details: err.details });
});

app.listen(PORT, () => {
  console.log(`Budget Guardian server on http://localhost:${PORT}`);
  if (SYNC_MINUTES > 0) background();
});
