import express from 'express';
import path from 'node:path';
import { openDb, DB_PATH } from './src/db.js';
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
import { PlaidError, plaidConfig, connect as connectPlaid, disconnect as disconnectPlaid, listItems as plaidItems, syncPlaid, plaidClient } from './src/plaid.js';
import { StatementError, previewStatement, importStatement, listImports, removeImport, sampleStatement } from './src/statements.js';
import { vapidKeys, subscribe, unsubscribe, isSubscribed, pushSender, runAlerts, listAlerts, deviceCount } from './src/alerts.js';
import { createWorkspaces, copyPayPal } from './src/workspaces.js';
import { createPayoutLimit } from './src/payoutLimit.js';

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BASE_URL, PORT = 3000 } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_BASE_URL) {
  console.error('Missing PayPal settings. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// The shared database: the PayPal sync, the AI cache and, with WORKSPACES=1, the list of
// visitors' workspaces. Without WORKSPACES it is also everyone's data (local use).
const shared = openDb();
const workspaces = process.env.WORKSPACES === '1'
  ? createWorkspaces({ shared, sharedFile: DB_PATH, dir: path.join(path.dirname(DB_PATH), 'workspaces') })
  : null;

// The public demo's daily limits on real sandbox payouts (DEMO_PAYOUT_DAILY_CAP_USD).
const capUsd = Number(process.env.DEMO_PAYOUT_DAILY_CAP_USD);
const payoutLimit = capUsd > 0
  ? createPayoutLimit(shared, { dailyCents: Math.round(capUsd * 100), perVisitorDaily: Number(process.env.DEMO_PAYOUTS_PER_VISITOR) || 8 })
  : null;

const app = express();
// On Render, requests arrive through a proxy; req.ip is then the visitor's address.
app.set('trust proxy', 1);
// Statements are uploaded as text inside JSON, up to 1 MB.
app.use(express.json({ limit: '2mb' }));
// The React dashboard's production build (npm run build).
app.use(express.static('client/dist'));

// For Render's health check: the server is up and the database answers.
app.get('/api/health', (req, res) => {
  shared.prepare('SELECT 1').get();
  res.json({ ok: true, demoAsOf: process.env.DEMO_AS_OF?.trim() || null, workspaces: Boolean(workspaces) });
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

// A sample card statement ending today, to try the upload with.
app.get('/api/statements/sample.csv', (req, res) => {
  res.type('text/csv').attachment('sample-card-statement.csv').send(sampleStatement());
});

// Plaid calls this when new transactions are ready. It only ever triggers a sync, which
// fetches from Plaid itself, so a forged call can't inject anything.
app.post('/api/plaid/webhook', (req, res) => {
  if (req.body?.webhook_type === 'TRANSACTIONS') {
    const owner = workspaces?.ownerOfItem(String(req.body.item_id ?? ''));
    const db = workspaces ? (owner && workspaces.get(owner)?.db) : shared;
    if (db) syncPlaidNow(db).catch((err) => console.error('Plaid sync failed:', err.message));
  }
  res.json({ ok: true });
});

// --- Whose data: with WORKSPACES=1 every visitor has their own (see src/workspaces.js),
// found through a cookie and created on the first visit. Everything below uses req.db.
const COOKIE = 'bg_workspace';
const cookieOf = (req) => (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === COOKIE)?.[1];
const setCookie = (req, res, id) =>
  res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: req.secure || req.get('x-forwarded-proto') === 'https', maxAge: 30 * 86_400_000, path: '/' });

app.use('/api', (req, res, next) => {
  if (!workspaces) {
    req.db = shared;
    return next();
  }
  try {
    const ws = workspaces.get(cookieOf(req)) ?? workspaces.create();
    if (ws.created) setCookie(req, res, ws.id);
    req.db = ws.db;
    req.workspaceId = ws.id;
    next();
  } catch (err) {
    next(err);
  }
});

// Whether this visitor has their own demo copy, and a way to start it over.
app.get('/api/workspace', (req, res) => res.json({ perVisitor: Boolean(workspaces) }));
app.post('/api/workspace/reset', (req, res) => {
  if (!workspaces) return res.status(409).json({ error: 'this server has one shared demo; reset it with npm run reset-demo' });
  workspaces.remove(req.workspaceId);
  const ws = workspaces.create();
  setCookie(req, res, ws.id);
  res.json({ ok: true });
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
    return detectSpikes(req.db, asOf ? { asOf } : {});
  } catch (err) {
    res.status(400).json({ error: err.message });
    return null;
  }
}

// Spikes with their causes and savings options.
app.get('/api/spikes', (req, res) => {
  const report = reportFor(req, res);
  if (report) res.json(suggestSavingsForSpikes(req.db, explainSpikes(req.db, report)));
});

// Savings options for one category, spiking or not: ?category=entertainment
app.get('/api/savings', (req, res) => {
  const report = reportFor(req, res);
  if (!report) return;
  const entry = report.categories.find((c) => c.category === req.query.category);
  if (!entry) return res.status(404).json({ error: `no spending found in category "${req.query.category}"` });
  res.json(suggestSavings(req.db, report, entry));
});

// Friendly advice for every spike: cause, savings options and AI-written text (or a
// code-written fallback). Add ?category=entertainment to also get a non-spiking category.
app.get('/api/advice', async (req, res, next) => {
  const report = reportFor(req, res);
  if (!report) return;
  try {
    // The dashboard never waits for the LLM: uncached text arrives on a later load.
    const result = await adviseSpikes(req.db, report, { wait: false });
    const extra = [req.query.category ?? []].flat().filter((c) => !report.spikes.some((s) => s.category === c));
    const others = [];
    for (const category of extra) {
      const entry = report.categories.find((c) => c.category === category);
      if (entry) others.push({ ...entry, ...(await adviseCategory(req.db, report, entry, { wait: false })) });
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
  const { approval, duplicate } = await approve(req.db, { optionId, expectedAmountCents, asOf }, { limit: payoutLimit, visitor: req.ip });
  res.status(duplicate ? 200 : 201).json({ ...withFollowThrough(req.db, approval), duplicate });
}));

// Each approval with how the user is doing on its plan (followThrough).
app.get('/api/approvals', (req, res) => res.json(listApprovals(req.db).map((a) => withFollowThrough(req.db, a))));

// Returns the approval, first refreshing a sent payout's status from PayPal.
app.get('/api/approvals/:id', approvalRoute(async (req, res) => {
  if (!getApproval(req.db, req.params.id)) throw new ApprovalError(404, 'approval not found');
  res.json(withFollowThrough(req.db, await refresh(req.db, req.params.id)));
}));

app.post('/api/approvals/:id/retry', approvalRoute(async (req, res) => {
  res.json(withFollowThrough(req.db, await retry(req.db, req.params.id)));
}));

// --- Rescue plan: the planning agent's proposal for getting back under budget.
// Never waits for the agent: the rules plan is returned until the agent's plan is ready.
app.get('/api/rescue', async (req, res, next) => {
  const report = reportFor(req, res);
  if (!report) return;
  try {
    res.json(await rescuePlan(req.db, report, { wait: false }));
  } catch (err) {
    next(err);
  }
});

// Approves every plan in the rescue plan: { items: [{ optionId, expectedAmountCents }], confirm: true }.
// Each goes through the normal approval (amount rechecked, balance checked).
app.post('/api/rescue/approve', approvalRoute(async (req, res) => {
  if (req.body?.confirm !== true) throw new ApprovalError(400, 'approval must be confirmed by the user (confirm: true)');
  const results = await approveRescue(req.db, req.body.items, { limit: payoutLimit, visitor: req.ip });
  res.json(results.map((r) => (r.approval ? { ...r, approval: withFollowThrough(req.db, r.approval) } : r)));
}));

// --- Device alerts (Web Push). New alerts go out after each sync.
app.get('/api/alerts', (req, res) => {
  res.json({ publicKey: vapidKeys(req.db).publicKey, devices: deviceCount(req.db), alerts: listAlerts(req.db) });
});

// A browser turned alerts on: { subscription } from PushManager.subscribe(). It gets this
// month's current alerts right away.
app.post('/api/alerts/subscribe', async (req, res, next) => {
  try {
    subscribe(req.db, req.body?.subscription);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  try {
    const result = await runAlerts(req.db, detectSpikes(req.db), { only: req.body.subscription.endpoint });
    res.json({ ok: true, delivered: result.sent });
  } catch (err) {
    next(err);
  }
});

app.post('/api/alerts/unsubscribe', (req, res) => {
  if (typeof req.body?.endpoint !== 'string') return res.status(400).json({ error: 'endpoint is required' });
  unsubscribe(req.db, req.body.endpoint);
  res.json({ ok: true });
});

// Sends a test alert to the one device asking. At most one a minute per device.
const lastTest = new Map();
app.post('/api/alerts/test', async (req, res, next) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string' || !isSubscribed(req.db, endpoint)) return res.status(404).json({ error: 'alerts are not on for this device' });
  if (Date.now() - (lastTest.get(endpoint) ?? 0) < 60_000) return res.status(429).json({ error: 'a test alert was sent less than a minute ago' });
  lastTest.set(endpoint, Date.now());
  try {
    const sub = req.db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
    await pushSender(req.db)(sub, { title: 'Budget Guardian alerts are on', body: "You'll get an alert here when a category starts spiking or a plan goes off track.", tag: 'test', url: '/' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// The monthly budget: safe to spend, per day, and whether spikes push the month over.
app.get('/api/budget', (req, res) => {
  const report = reportFor(req, res);
  if (report) res.json(budgetStatus(req.db, report));
});

// The user sets their monthly budget: { "monthlyCents": 110000 }
app.put('/api/budget', (req, res) => {
  try {
    setBudget(req.db, req.body?.monthlyCents);
  } catch (err) {
    if (err instanceof RangeError) return res.status(400).json({ error: err.message });
    throw err;
  }
  const report = reportFor(req, res);
  if (report) res.json(budgetStatus(req.db, report));
});

// Monthly totals per category for the dashboard charts.
app.get('/api/history', (req, res) => {
  const report = reportFor(req, res);
  if (report) res.json(monthlyHistory(req.db, report));
});

// Small, frequent purchases from past months in flexible categories, with cut-back savings.
app.get('/api/habits', (req, res) => {
  const report = reportFor(req, res);
  if (report) res.json({ asOf: report.asOf, baselineMonths: report.baselineMonths, habits: habitInsights(req.db, report) });
});

// Labels uncategorized transactions with the LLM. Safe to call repeatedly: only
// unlabeled transactions are sent, and failures leave them for the next call.
// Spends LLM quota, so on a public deployment (ADMIN_TOKEN set) it needs that token.
app.post('/api/categorize', async (req, res, next) => {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (token && req.get('Authorization') !== `Bearer ${token}`) return res.status(401).json({ error: 'admin token required' });
  try {
    res.json({ ...(await categorize(req.db)), accuracy: accuracy(req.db) });
  } catch (err) {
    next(err);
  }
});

// Every category seen in transactions, with whether the user marked it flexible.
app.get('/api/categories', (req, res) => {
  res.json(
    req.db
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
  setFlexible(req.db, req.params.category, req.body.flexible);
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

// Labels new purchases from uploads and Plaid (the LLM first, then name rules for what it
// couldn't), then checks for new spikes. In the background, one run per database at a time:
// the dashboard polls.
const labeling = new Map(); // db -> promise
function labelImported(db) {
  if (!labeling.has(db)) {
    labeling.set(db, categorize(db)
      .catch((err) => console.error('Labeling new purchases failed:', err.message))
      .then(() => labelByRules(db))
      .then(() => runAlerts(db, detectSpikes(db)))
      .catch((err) => console.error('Alerts after new purchases failed:', err.message))
      .finally(() => labeling.delete(db)));
  }
  return labeling.get(db);
}

// { text, layout? } -> the layout (read by the AI, or rules) and what would be imported.
app.post('/api/statements/preview', statementRoute(async (req, res) => {
  res.json(await previewStatement(req.db, { text: req.body?.text, layout: req.body?.layout }));
}));

// { text, layout, filename } -> imports the purchases with the layout the user previewed.
app.post('/api/statements/import', statementRoute(async (req, res) => {
  const result = importStatement(req.db, { text: req.body?.text, layout: req.body?.layout, filename: req.body?.filename });
  if (result.added) labelImported(req.db);
  res.status(result.added ? 201 : 200).json(result);
}));

app.get('/api/statements', (req, res) => res.json({ imports: listImports(req.db), labeling: labeling.has(req.db) }));

app.delete('/api/statements/:id', statementRoute(async (req, res) => {
  res.json(removeImport(req.db, req.params.id));
}));

// --- Plaid: banks and credit cards connected through Plaid Link.
const plaidRoute = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (err) {
    if (err instanceof PlaidError) return res.status(err.status >= 500 ? 502 : err.status).json({ error: err.message, details: err.details?.error_code });
    next(err);
  }
};

app.get('/api/plaid/status', (req, res) => {
  const config = plaidConfig();
  res.json({ configured: config.configured, env: config.env, items: plaidItems(req.db) });
});

// A short-lived token that opens Plaid Link in the browser.
const publicUrl = () => (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/$/, '');
app.post('/api/plaid/link-token', plaidRoute(async (req, res) => {
  const webhook = publicUrl() ? `${publicUrl()}/api/plaid/webhook` : undefined;
  res.json({ linkToken: await plaidClient.createLinkToken({ webhook }) });
}));

// One Plaid sync per database at a time; new purchases are then labeled.
const plaidSyncing = new Map(); // db -> promise
function syncPlaidNow(db) {
  if (!plaidSyncing.has(db)) {
    plaidSyncing.set(db, syncPlaid(db)
      .then((r) => { if (r.some((x) => x.added || x.updated || x.removed)) labelImported(db); return r; })
      .finally(() => plaidSyncing.delete(db)));
  }
  return plaidSyncing.get(db);
}

// Plaid Link finished: { publicToken, institution }. Transactions follow in the background.
app.post('/api/plaid/exchange', plaidRoute(async (req, res) => {
  const itemId = await connectPlaid(req.db, { publicToken: req.body?.publicToken, institution: req.body?.institution });
  if (workspaces) workspaces.setItemOwner(itemId, req.workspaceId);
  syncPlaidNow(req.db).catch((err) => console.error('Plaid sync failed:', err.message));
  res.status(201).json({ itemId });
}));

// Sync now. At most once every 15 seconds per visitor.
const lastPlaidSync = new Map();
app.post('/api/plaid/sync', plaidRoute(async (req, res) => {
  if (!plaidSyncing.has(req.db) && Date.now() - (lastPlaidSync.get(req.db) ?? 0) < 15_000) return res.status(429).json({ error: 'synced less than 15 seconds ago' });
  lastPlaidSync.set(req.db, Date.now());
  res.json({ results: await syncPlaidNow(req.db), labeling: labeling.has(req.db) });
}));

app.delete('/api/plaid/items/:id', plaidRoute(async (req, res) => {
  res.json(await disconnectPlaid(req.db, req.params.id));
}));

// Sandbox only, for demos: a card purchase on the first connected sandbox account
// ({ amount: 89.4, description: 'SHELL OIL 57444' }). Needs ADMIN_TOKEN when one is set.
// With workspaces, it goes to the most recently connected account of any visitor (the demo
// presenter's), since a script has no visitor cookie.
app.post('/api/plaid/sandbox-purchase', plaidRoute(async (req, res) => {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (token && req.get('Authorization') !== `Bearer ${token}`) return res.status(401).json({ error: 'admin token required' });
  if (plaidConfig().env !== 'sandbox') return res.status(403).json({ error: 'only in the Plaid sandbox' });
  const amount = Number(req.body?.amount);
  const description = String(req.body?.description ?? '').trim();
  if (!(amount > 0 && amount < 10_000) || !description) return res.status(400).json({ error: 'amount (dollars) and description are required' });
  let db = req.db;
  if (workspaces) {
    const latest = shared.prepare('SELECT workspace_id FROM plaid_item_workspaces ORDER BY rowid DESC LIMIT 1').get();
    db = latest && workspaces.get(latest.workspace_id)?.db;
  }
  const item = db?.prepare('SELECT access_token, institution FROM plaid_items ORDER BY created_at DESC LIMIT 1').get();
  if (!item) return res.status(404).json({ error: 'connect a sandbox account first' });
  const date = today();
  await plaidClient.createSandboxTransaction(item.access_token, { amount, description, date_transacted: date, date_posted: date, iso_currency_code: 'USD' });
  await plaidClient.refresh(item.access_token).catch(() => null);
  // Plaid's webhook triggers a sync on a public server; this covers local runs.
  setTimeout(() => syncPlaidNow(db).catch(() => null), 15_000).unref();
  res.status(201).json({ ok: true, institution: item.institution, amount, description, date });
}));

// --- Sync: pull new PayPal transactions (shared), then bring each visitor's data up to date
// (demo history, PayPal copy, Plaid, labels, alerts). Runs at startup and every
// SYNC_INTERVAL_MINUTES (default 15); the dashboard can also ask.
async function syncShared() {
  const result = await syncPayPal(shared);
  // Label new PayPal merchants: the LLM first, then name rules.
  const labels = await categorize(shared).catch((err) => ({ errors: [err.message] }));
  return { ...result, labeledByAi: labels.labeledTransactions ?? 0, labeledByRules: labelByRules(shared) };
}

async function refreshData(db) {
  // DEMO_ROLLING: the seeded history is regenerated to end today when a new day starts,
  // so a long-running demo always has a current month. Other rows are never touched.
  if (process.env.DEMO_ROLLING === '1') seedDemoIfStale(db, { end: today() });
  if (db !== shared) copyPayPal(db);
  const plaid = plaidConfig().configured && db.prepare('SELECT 1 FROM plaid_items').get() ? await syncPlaid(db).catch((err) => [{ error: err.message }]) : [];
  if (db !== shared) {
    await categorize(db).catch((err) => console.error('Labeling failed:', err.message));
    labelByRules(db);
  }
  // Alerts last, so they see the newly labeled transactions.
  const alerts = await runAlerts(db, detectSpikes(db)).catch((err) => ({ error: err.message }));
  return { plaid, alerts };
}

let syncing = null;
function runSync() {
  syncing ??= (async () => {
    const result = await syncShared().catch((err) => ({ error: err.message }));
    const targets = workspaces ? workspaces.active().map((w) => w.db) : [shared];
    for (const db of targets) await refreshData(db).catch((err) => console.error('Refresh failed:', err.message));
    if (workspaces) workspaces.cleanup();
    if (result.error) throw new Error(result.error);
    return { ...result, refreshed: targets.length };
  })().finally(() => { syncing = null; });
  return syncing;
}

app.get('/api/paypal/status', (req, res) => res.json({ ...syncStatus(shared), syncing: Boolean(syncing) }));

// The most recent spending that came from PayPal (not the seeded history).
app.get('/api/paypal/transactions', (req, res) => {
  res.json(
    req.db.prepare(`
      SELECT id, occurred_at AS occurredAt, merchant, description, amount_cents AS amountCents,
             COALESCE(category, seed_category) AS category
      FROM transactions WHERE source = 'paypal' ORDER BY occurred_at DESC LIMIT 10
    `).all(),
  );
});

// Sync now: PayPal (shared, at most once every 30 seconds), then this visitor's data.
let sharedSyncing = null;
app.post('/api/paypal/sync', async (req, res, next) => {
  const last = syncStatus(shared).lastSyncAt;
  if (!sharedSyncing && !syncing && last && Date.now() - Date.parse(last) < 30_000) {
    return res.status(429).json({ error: 'synced less than 30 seconds ago', status: syncStatus(shared) });
  }
  try {
    sharedSyncing ??= syncShared().finally(() => { sharedSyncing = null; });
    const result = await sharedSyncing;
    await refreshData(req.db);
    res.json({ result, status: syncStatus(shared) });
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
  console.log(`Budget Guardian server on http://localhost:${PORT}${workspaces ? ` (per-visitor demo, ${workspaces.count()} workspaces)` : ''}`);
  if (SYNC_MINUTES > 0) background();
});
