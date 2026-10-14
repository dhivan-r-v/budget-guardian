// Brings the user's PayPal transactions into the spending history.
//
// Only spending is stored. A PayPal account's history also holds money coming in (sales,
// the sandbox opening balance), PayPal's own bookkeeping (holds and their releases around
// each payout), and Budget Guardian's savings transfers. Counting any of those would invent
// spikes, so classify() keeps only outgoing payments. Transactions keep their PayPal id, so
// syncing again never duplicates anything. New merchants are then labeled by the categorizer.
import * as paypalClient from './paypal.js';

const SYNC_DAYS = 90;

// PayPal event codes: T00xx are payments; T0001 is a mass payment / payout.
const isPaymentCode = (code) => /^T00\d\d$/.test(code ?? '');

export function classify(detail, { savingsReceiver } = {}) {
  const info = detail.transaction_info ?? {};
  const value = Number(info.transaction_amount?.value);
  if (info.transaction_status !== 'S' || !Number.isFinite(value)) return { kind: 'skipped', reason: 'not completed' };
  if (info.transaction_amount?.currency_code !== 'USD') return { kind: 'skipped', reason: 'not USD' };
  if (value >= 0) return { kind: 'income' };
  if (!isPaymentCode(info.transaction_event_code)) return { kind: 'skipped', reason: 'not a payment (hold, fee, transfer)' };

  const counterparty = detail.payer_info ?? {};
  const toSavings =
    info.transaction_event_code === 'T0001' &&
    ((savingsReceiver && counterparty.email_address?.toLowerCase() === savingsReceiver.toLowerCase()) ||
      /^Budget Guardian/.test(info.transaction_note ?? '') ||
      /^Budget Guardian/.test(info.transaction_subject ?? ''));
  if (toSavings) return { kind: 'savings' };

  const items = (detail.cart_info?.item_details ?? []).map((i) => i.item_name).filter(Boolean);
  const merchant =
    counterparty.payer_name?.alternate_full_name ||
    [counterparty.payer_name?.given_name, counterparty.payer_name?.surname].filter(Boolean).join(' ') ||
    detail.shipping_info?.name ||
    info.transaction_subject ||
    'PayPal payment';
  return {
    kind: 'spending',
    row: {
      id: `paypal-${info.transaction_id}`,
      occurred_at: new Date(info.transaction_initiation_date).toISOString().slice(0, 19) + 'Z',
      amount_cents: Math.round(-value * 100),
      merchant: merchant.trim(),
      description: (info.transaction_subject || items.join(', ') || info.transaction_note || null)?.trim() || null,
    },
  };
}

const setState = (db, key, value) =>
  db.prepare('INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);

export function syncStatus(db) {
  const get = (key) => db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key)?.value ?? null;
  const n = db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'paypal'").get().n;
  const last = get('paypal_last_sync');
  return {
    lastSyncAt: last,
    paypalRefreshedTo: get('paypal_refreshed_to'),
    lastError: get('paypal_last_error') || null,
    lastResult: last ? JSON.parse(get('paypal_last_result') ?? 'null') : null,
    paypalTransactions: n,
  };
}

// Fetches the last SYNC_DAYS days and stores new spending. `client` and `now` are injectable.
export async function syncPayPal(db, { client = paypalClient, now = new Date(), savingsReceiver = process.env.SAVINGS_RECEIVER_EMAIL?.trim(), days = SYNC_DAYS } = {}) {
  const start = new Date(now.getTime() - days * 86_400_000);
  let fetched;
  try {
    fetched = await client.searchTransactions(start, now);
  } catch (err) {
    setState(db, 'paypal_last_error', `${err.details?.name ? `${err.details.name}: ` : ''}${err.message}`);
    throw err;
  }

  const counts = { fetched: fetched.details.length, added: 0, alreadyStored: 0, savings: 0, income: 0, skipped: 0 };
  const insert = db.prepare(`
    INSERT OR IGNORE INTO transactions (id, occurred_at, amount_cents, currency, merchant, description, source)
    VALUES (?, ?, ?, 'USD', ?, ?, 'paypal')
  `);
  db.exec('BEGIN');
  try {
    for (const detail of fetched.details) {
      const c = classify(detail, { savingsReceiver });
      if (c.kind !== 'spending') {
        counts[c.kind === 'skipped' ? 'skipped' : c.kind]++;
        continue;
      }
      const { changes } = insert.run(c.row.id, c.row.occurred_at, c.row.amount_cents, c.row.merchant, c.row.description);
      if (changes) counts.added++;
      else counts.alreadyStored++;
    }
    setState(db, 'paypal_last_sync', now.toISOString());
    setState(db, 'paypal_last_result', JSON.stringify(counts));
    setState(db, 'paypal_last_error', '');
    if (fetched.lastRefreshed) setState(db, 'paypal_refreshed_to', fetched.lastRefreshed);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return counts;
}
