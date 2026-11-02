// Card and bank spending through Plaid, the way US budgeting apps connect to banks.
//
// The user connects a bank or credit card in Plaid Link (Plaid's own window: Budget Guardian
// never sees their bank login). Plaid hands the server an access token for that connection
// (an "item"), kept server-side only. syncPlaid() then pulls new, changed and removed
// transactions with /transactions/sync and its cursor, so each sync only fetches what changed.
//
// Only spending is stored: posted (not pending) USD outflows. Transfers between the user's
// own accounts, card and loan payments, income and PayPal payments (already tracked by the
// PayPal sync) are skipped, since counting them would invent spikes. Plaid's own category
// is kept in the description, which helps the categorizer and the name rules label it.
const BASES = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' };

export class PlaidError extends Error {
  constructor(status, details) {
    super(details?.error_message ?? details?.message ?? `Plaid request failed (${status})`);
    this.status = status;
    this.details = details;
  }
}

export function plaidConfig(env = process.env) {
  const clientId = env.PLAID_CLIENT_ID?.trim();
  const secret = env.PLAID_SECRET?.trim();
  const plaidEnv = env.PLAID_ENV?.trim() || 'sandbox';
  return { configured: Boolean(clientId && secret && BASES[plaidEnv]), clientId, secret, env: plaidEnv, base: BASES[plaidEnv] };
}

async function call(path, body, config = plaidConfig()) {
  if (!config.configured) throw new PlaidError(503, { message: 'Plaid is not set up (PLAID_CLIENT_ID, PLAID_SECRET)' });
  const res = await fetch(`${config.base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: config.clientId, secret: config.secret, ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PlaidError(res.status, data);
  return data;
}

// The real client; tests pass a fake with the same methods.
export const plaidClient = {
  createLinkToken: ({ webhook } = {}) =>
    call('/link/token/create', {
      client_name: 'Budget Guardian',
      user: { client_user_id: 'budget-guardian-demo-user' },
      products: ['transactions'],
      transactions: { days_requested: 180 },
      country_codes: ['US'],
      language: 'en',
      ...(webhook && { webhook }),
    }).then((r) => r.link_token),
  exchange: (publicToken) => call('/item/public_token/exchange', { public_token: publicToken }).then((r) => ({ accessToken: r.access_token, itemId: r.item_id })),
  sync: (accessToken, cursor) => call('/transactions/sync', { access_token: accessToken, ...(cursor && { cursor }), count: 500 }),
  accounts: (accessToken) => call('/accounts/get', { access_token: accessToken }).then((r) => r.accounts),
  remove: (accessToken) => call('/item/remove', { access_token: accessToken }),
  // Sandbox only: a test purchase on a connected sandbox card (user_transactions_dynamic).
  createSandboxTransaction: (accessToken, t) => call('/sandbox/transactions/create', { access_token: accessToken, transactions: [t] }),
  refresh: (accessToken) => call('/transactions/refresh', { access_token: accessToken }),
};

// --- Which Plaid transactions are spending

const SKIP_PRIMARY = new Set(['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS', 'BANK_FEES']);

export function classify(t) {
  if (t.pending) return { kind: 'skipped', reason: 'pending' };
  if ((t.iso_currency_code ?? 'USD') !== 'USD') return { kind: 'skipped', reason: 'not USD' };
  if (!(t.amount > 0)) return { kind: 'income' }; // Plaid: positive = money out
  const primary = t.personal_finance_category?.primary;
  if (SKIP_PRIMARY.has(primary)) return { kind: 'skipped', reason: `not spending (${primary})` };
  if (/paypal/i.test(`${t.merchant_name ?? ''} ${t.name ?? ''}`)) return { kind: 'paypal' };
  return { kind: 'spending' };
}

const row = (itemId, t) => ({
  id: `plaid-${t.transaction_id}`,
  occurredAt: `${t.authorized_date ?? t.date}T12:00:00Z`,
  amountCents: Math.round(t.amount * 100),
  merchant: (t.merchant_name || t.name || 'Unknown').slice(0, 60),
  // Plaid's category (e.g. TRANSPORTATION_GAS) helps the categorizer and the name rules.
  description: [t.name, t.personal_finance_category?.detailed].filter(Boolean).join(' · ').slice(0, 200),
  itemId,
});

// --- Connections

export function listItems(db) {
  return db.prepare(`
    SELECT p.item_id AS id, p.institution, p.accounts, p.last_sync_at AS lastSyncAt, p.error, p.created_at AS createdAt,
           (SELECT COUNT(*) FROM transactions t WHERE t.import_id = p.item_id) AS transactions
    FROM plaid_items p ORDER BY p.created_at
  `).all().map((r) => ({ ...r, accounts: JSON.parse(r.accounts ?? '[]') }));
}

// Called with Plaid Link's public token after the user connected an account.
export async function connect(db, { publicToken, institution }, { client = plaidClient } = {}) {
  if (typeof publicToken !== 'string' || !publicToken) throw new PlaidError(400, { message: 'publicToken is required' });
  const { accessToken, itemId } = await client.exchange(publicToken);
  const accounts = await client.accounts(accessToken).catch(() => []);
  db.prepare(`
    INSERT INTO plaid_items (item_id, access_token, institution, accounts) VALUES (?, ?, ?, ?)
    ON CONFLICT (item_id) DO UPDATE SET access_token = excluded.access_token
  `).run(itemId, accessToken, String(institution ?? 'Bank').slice(0, 80), JSON.stringify(accounts.map((a) => ({ name: a.name, mask: a.mask, type: a.subtype ?? a.type }))));
  return itemId;
}

export async function disconnect(db, itemId, { client = plaidClient } = {}) {
  const item = db.prepare('SELECT access_token FROM plaid_items WHERE item_id = ?').get(itemId);
  if (!item) throw new PlaidError(404, { message: 'connection not found' });
  await client.remove(item.access_token).catch(() => null); // gone at Plaid already is fine
  const removed = db.prepare("DELETE FROM transactions WHERE source = 'plaid' AND import_id = ?").run(itemId).changes;
  db.prepare('DELETE FROM plaid_items WHERE item_id = ?').run(itemId);
  return { removed: Number(removed) };
}

// --- Sync

// Pulls every page of changes since the item's cursor, then applies them in one transaction
// and saves the new cursor. If anything fails, nothing is applied and the old cursor stays,
// so the next sync simply starts over from the same point.
async function syncItem(db, item, client) {
  let cursor = item.cursor;
  const added = [];
  const modified = [];
  const removed = [];
  for (let page = 0; page < 50; page++) {
    const r = await client.sync(item.access_token, cursor);
    added.push(...(r.added ?? []));
    modified.push(...(r.modified ?? []));
    removed.push(...(r.removed ?? []));
    cursor = r.next_cursor;
    if (!r.has_more) break;
  }
  const counts = { added: 0, updated: 0, removed: 0, paypal: 0, income: 0, skipped: 0 };
  const upsert = db.prepare(`
    INSERT INTO transactions (id, occurred_at, amount_cents, currency, merchant, description, source, import_id)
    VALUES (?, ?, ?, 'USD', ?, ?, 'plaid', ?)
    ON CONFLICT (id) DO UPDATE SET occurred_at = excluded.occurred_at, amount_cents = excluded.amount_cents,
      merchant = excluded.merchant, description = excluded.description
  `);
  const del = db.prepare('DELETE FROM transactions WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const [list, isNew] of [[added, true], [modified, false]]) {
      for (const t of list) {
        const c = classify(t);
        if (c.kind !== 'spending') {
          // A modified transaction can stop being spending (e.g. recategorized as a transfer).
          if (!isNew) del.run(`plaid-${t.transaction_id}`);
          counts[c.kind === 'skipped' ? 'skipped' : c.kind]++;
          continue;
        }
        const r = row(item.item_id, t);
        const existed = db.prepare('SELECT 1 FROM transactions WHERE id = ?').get(r.id);
        upsert.run(r.id, r.occurredAt, r.amountCents, r.merchant, r.description, r.itemId);
        counts[existed ? 'updated' : 'added']++;
      }
    }
    for (const t of removed) counts.removed += Number(del.run(`plaid-${t.transaction_id}`).changes);
    db.prepare("UPDATE plaid_items SET cursor = ?, last_sync_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), error = NULL WHERE item_id = ?").run(cursor, item.item_id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return counts;
}

export async function syncPlaid(db, { client = plaidClient } = {}) {
  const results = [];
  for (const item of db.prepare('SELECT * FROM plaid_items').all()) {
    try {
      results.push({ itemId: item.item_id, ...(await syncItem(db, item, client)) });
    } catch (err) {
      db.prepare('UPDATE plaid_items SET error = ? WHERE item_id = ?').run(err.message, item.item_id);
      results.push({ itemId: item.item_id, error: err.message });
    }
  }
  return results;
}
