// Alerts that appear on the user's devices (Web Push), so they hear about a spike without
// opening the dashboard:
//   - a category starts spiking this month
//   - an approved plan goes over what it allows
// Each device that turned alerts on gets each alert once. The text is written by code from
// the same figures as the dashboard; no LLM is involved, so every number is exact.
//
// Push needs a VAPID key pair. It is read from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or
// generated once and kept in the database, so alerts work without any setup.
import webpush from 'web-push';
import { usd } from './advisor.js';
import { listApprovals, followThrough } from './approvals.js';

const MAX_ATTEMPTS = 3;

// "2026-10-31" -> "Oct 31"
const dateShort = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function vapidKeys(db, env = process.env) {
  if (env.VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim()) {
    return { publicKey: env.VAPID_PUBLIC_KEY.trim(), privateKey: env.VAPID_PRIVATE_KEY.trim() };
  }
  const stored = db.prepare("SELECT value FROM sync_state WHERE key = 'vapid_keys'").get();
  if (stored) return JSON.parse(stored.value);
  const keys = webpush.generateVAPIDKeys();
  db.prepare("INSERT INTO sync_state (key, value) VALUES ('vapid_keys', ?)").run(JSON.stringify(keys));
  return keys;
}

// --- Devices

// The browsers' own push services. The demo is public, so the server only ever sends to
// these, never to an arbitrary address someone posts.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /\.push\.apple\.com$/];
const MAX_DEVICES = 200;

export function subscribe(db, subscription) {
  const { endpoint, keys } = subscription ?? {};
  let host = null;
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'https:') host = url.hostname;
  } catch {}
  if (!host || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
    throw new RangeError('subscription must have an https endpoint and p256dh/auth keys');
  }
  if (!PUSH_HOSTS.some((re) => re.test(host))) throw new RangeError(`${host} is not a browser push service`);
  if (!isSubscribed(db, endpoint) && deviceCount(db) >= MAX_DEVICES) throw new RangeError('too many devices have alerts turned on');
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
    ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
  `).run(endpoint, keys.p256dh, keys.auth);
}

export function unsubscribe(db, endpoint) {
  db.prepare('DELETE FROM notification_deliveries WHERE endpoint = ?').run(endpoint);
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export const isSubscribed = (db, endpoint) => Boolean(db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(endpoint));
const subscriptions = (db) => db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions').all();

// Sends one notification to one device. 404/410 mean the device turned alerts off or the
// subscription expired; it is removed so it isn't tried again.
export function pushSender(db) {
  const keys = vapidKeys(db);
  const subject = process.env.VAPID_SUBJECT?.trim() || 'mailto:alerts@budget-guardian.example.com';
  return async (sub, payload) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 24 * 3600, timeout: 15_000 },
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        unsubscribe(db, sub.endpoint);
        err.gone = true;
      }
      throw err;
    }
  };
}

// --- What to say

// The alerts this report calls for. Short enough for a phone's lock screen.
export function candidateAlerts(db, report) {
  const out = [];
  const approvals = listApprovals(db).filter((a) => a.month === report.month && a.status !== 'failed');
  for (const s of report.spikes) {
    const approved = approvals.some((a) => a.category === s.category);
    const pct = s.increasePct === null ? '' : ` ${Math.round(s.increasePct)}%`;
    out.push({
      key: `spike:${s.category}:${report.month}`,
      kind: 'spike',
      category: s.category,
      month: report.month,
      title: `${cap(s.category)} spending is${pct} above usual`,
      body: `Heading for ${usd(s.projectedCents)} this month (usual ${usd(s.baselineAvgCents)}). ${approved ? 'You already have a plan for it.' : 'Tap to see ways to save.'}`,
    });
  }
  for (const a of approvals) {
    const f = followThrough(db, a, { asOf: report.asOf });
    if (f?.status !== 'over') continue;
    out.push({
      key: `plan_over:${a.id}`,
      kind: 'plan_over',
      category: a.category,
      month: a.month,
      title: `Your ${a.category} plan is off track`,
      body:
        f.kind === 'cap'
          ? `${usd(f.spentCents)} spent since you approved; the plan allows ${usd(f.allowanceCents)} until ${dateShort(f.endsOn)}.`
          : `${f.billedMerchants.join(' and ')} billed after you planned to skip ${f.billedMerchants.length > 1 ? 'them' : 'it'}.`,
    });
  }
  return out;
}

// --- Sending

// Sends every alert to every device that hasn't had it yet; a failed delivery is retried
// on later runs, up to MAX_ATTEMPTS. A delivery is claimed before it's sent, so overlapping
// runs can't send it twice.
export async function runAlerts(db, report, { send = pushSender(db), only } = {}) {
  const devices = subscriptions(db).filter((d) => !only || d.endpoint === only);
  let sent = 0;
  let failed = 0;
  if (!devices.length) return { devices: 0, sent, failed };
  for (const alert of candidateAlerts(db, report)) {
    db.prepare(`
      INSERT INTO notifications (key, kind, category, month, title, body) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO NOTHING
    `).run(alert.key, alert.kind, alert.category, alert.month, alert.title, alert.body);
    for (const device of devices) {
      const row = db.prepare('SELECT status, attempts FROM notification_deliveries WHERE key = ? AND endpoint = ?').get(alert.key, device.endpoint);
      if (row && (row.status !== 'failed' || row.attempts >= MAX_ATTEMPTS)) continue;
      if (row) db.prepare("UPDATE notification_deliveries SET status = 'sending', attempts = attempts + 1 WHERE key = ? AND endpoint = ?").run(alert.key, device.endpoint);
      else db.prepare("INSERT INTO notification_deliveries (key, endpoint, status, attempts) VALUES (?, ?, 'sending', 1)").run(alert.key, device.endpoint);
      try {
        await send(device, { title: alert.title, body: alert.body, tag: alert.key, url: '/' });
        db.prepare("UPDATE notification_deliveries SET status = 'sent', error = NULL, sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE key = ? AND endpoint = ?").run(alert.key, device.endpoint);
        sent++;
      } catch (err) {
        // A device that is gone was removed along with its deliveries.
        if (!err.gone) db.prepare("UPDATE notification_deliveries SET status = 'failed', error = ? WHERE key = ? AND endpoint = ?").run(err.message, alert.key, device.endpoint);
        failed++;
      }
    }
  }
  return { devices: devices.length, sent, failed };
}

export const listAlerts = (db) =>
  db.prepare(`
    SELECT n.key, n.kind, n.category, n.month, n.title, n.body, n.created_at AS createdAt,
           SUM(d.status = 'sent') AS sentTo, SUM(d.status = 'failed') AS failedTo
    FROM notifications n LEFT JOIN notification_deliveries d ON d.key = n.key
    GROUP BY n.key ORDER BY n.created_at DESC LIMIT 20
  `).all().map((r) => ({ ...r, sentTo: r.sentTo ?? 0, failedTo: r.failedTo ?? 0 }));

export const deviceCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;
