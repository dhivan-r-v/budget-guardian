// PayPal REST client (sandbox or live, from PAYPAL_BASE_URL). Credentials stay server-side.

export class PayPalError extends Error {
  constructor(status, details) {
    super(details?.error_description ?? details?.message ?? `PayPal request failed (${status})`);
    this.status = status;
    this.details = details;
  }
}

const env = () => {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_BASE_URL } = process.env;
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET || !PAYPAL_BASE_URL) throw new Error('Missing PayPal settings in .env');
  return { id: PAYPAL_CLIENT_ID.trim(), secret: PAYPAL_CLIENT_SECRET.trim(), base: PAYPAL_BASE_URL.trim() };
};

// Access tokens last ~9 hours; reuse one until shortly before it expires.
let cachedToken = null;
export async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;
  const { id, secret, base } = env();
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok) throw new PayPalError(res.status, data);
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return cachedToken.value;
}

export async function paypal(method, path, body) {
  const res = await fetch(`${env().base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await getAccessToken()}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new PayPalError(res.status, data);
  return data;
}

// Sends one payout. PayPal rejects a sender_batch_id reused within 30 days, so passing a
// stable id makes retries safe: the same approval can never be paid twice.
export async function createPayout({ senderBatchId, receiver, amountCents, note, subject }) {
  const data = await paypal('POST', '/v1/payments/payouts', {
    sender_batch_header: { sender_batch_id: senderBatchId, recipient_type: 'EMAIL', email_subject: subject },
    items: [
      {
        recipient_type: 'EMAIL',
        receiver,
        amount: { value: (amountCents / 100).toFixed(2), currency: 'USD' },
        note,
        sender_item_id: senderBatchId,
      },
    ],
  });
  return { payoutBatchId: data.batch_header.payout_batch_id, batchStatus: data.batch_header.batch_status };
}

// Transaction Search: every transaction between two dates. PayPal allows at most 31 days per
// request, so the range is split into windows, and each window's pages are followed.
// Returns the raw transaction_details plus how far PayPal's data is refreshed (it lags up to
// ~3 hours behind real time).
const WINDOW_MS = 31 * 86_400_000 - 1000;
export async function searchTransactions(start, end) {
  const details = [];
  let lastRefreshed = null;
  for (let from = start.getTime(); from < end.getTime(); from += WINDOW_MS) {
    const to = Math.min(from + WINDOW_MS, end.getTime());
    for (let page = 1, pages = 1; page <= pages; page++) {
      const q = new URLSearchParams({
        start_date: new Date(from).toISOString().slice(0, 19) + 'Z',
        end_date: new Date(to).toISOString().slice(0, 19) + 'Z',
        fields: 'all',
        page_size: '500',
        page: String(page),
      });
      const r = await paypal('GET', `/v1/reporting/transactions?${q}`);
      details.push(...(r.transaction_details ?? []));
      pages = r.total_pages ?? 1;
      if (r.last_refreshed_datetime) lastRefreshed = r.last_refreshed_datetime;
    }
  }
  return { details, lastRefreshed };
}

export async function getPayout(payoutBatchId) {
  const data = await paypal('GET', `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
  const item = data.items?.[0];
  return {
    batchStatus: data.batch_header.batch_status,
    itemStatus: item?.transaction_status ?? null,
    payoutItemId: item?.payout_item_id ?? null,
    transactionId: item?.transaction_id ?? null,
  };
}
