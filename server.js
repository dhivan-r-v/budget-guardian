import express from 'express';
import { openDb } from './src/db.js';
import { detectSpikes } from './src/spikes.js';
import { explainSpikes } from './src/causes.js';
import { suggestSavings, suggestSavingsForSpikes, setFlexible } from './src/savings.js';

const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BASE_URL, PORT = 3000 } = process.env;
if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_BASE_URL) {
  console.error('Missing PayPal settings. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const db = openDb();
const app = express();
app.use(express.json());

// Access tokens last ~9 hours; reuse one until shortly before it expires.
let cachedToken = null;
async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const auth = Buffer.from(`${PAYPAL_CLIENT_ID.trim()}:${PAYPAL_CLIENT_SECRET.trim()}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok) throw new PayPalError(res.status, data);

  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

class PayPalError extends Error {
  constructor(status, details) {
    super(details?.error_description ?? details?.message ?? `PayPal request failed (${status})`);
    this.status = status;
    this.details = details;
  }
}

async function paypal(method, path, body) {
  const res = await fetch(`${PAYPAL_BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new PayPalError(res.status, data);
  return data;
}

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
