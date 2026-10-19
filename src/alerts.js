// Email alerts, so the user hears about a spike without opening the dashboard:
//   - a category starts spiking this month (once per category per month)
//   - an approved plan goes over what it allows (once per plan)
// The text is written by code from the same figures as the dashboard; no LLM is involved, so
// every number in an email is exact. Emails go out through Resend's HTTP API, only to the
// address in ALERT_EMAIL_TO. Without RESEND_API_KEY and ALERT_EMAIL_TO nothing is sent.
import { adviseCategory, usd } from './advisor.js';
import { listApprovals, followThrough } from './approvals.js';

const MAX_ATTEMPTS = 3;

// "2026-10-31" -> "October 31"
const dateLong = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

export function emailConfig(env = process.env) {
  const apiKey = env.RESEND_API_KEY?.trim();
  const to = env.ALERT_EMAIL_TO?.trim();
  return {
    configured: Boolean(apiKey && to),
    apiKey,
    to,
    from: env.ALERT_EMAIL_FROM?.trim() || 'Budget Guardian <onboarding@resend.dev>',
    // Render sets RENDER_EXTERNAL_URL to the service's public address.
    appUrl: env.APP_URL?.trim() || env.RENDER_EXTERNAL_URL?.trim() || null,
  };
}

// "dhivan@example.com" -> "d•••@example.com", so the dashboard never shows the full address.
export const maskEmail = (email) => email?.replace(/^(.)[^@]*/, '$1•••') ?? null;

export async function sendEmail({ subject, text }, config = emailConfig()) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.from, to: [config.to], subject, text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `email failed (${res.status})`);
  }
}

const footer = (config) =>
  `\n\n${config.appUrl ? `Open Budget Guardian: ${config.appUrl}\n` : ''}Budget Guardian never moves money without your approval.`;

// The emails this report calls for, before checking which were already sent.
export async function candidateAlerts(db, report, config = emailConfig()) {
  const out = [];
  const approvals = listApprovals(db).filter((a) => a.month === report.month && a.status !== 'failed');
  for (const spike of report.spikes) {
    // Template advice only: the same code-written text the dashboard falls back to.
    const { advice, savings } = await adviseCategory(db, report, spike, { useAI: false });
    const approved = approvals.find((a) => a.category === spike.category);
    const plans = savings.flexible
      ? advice.options.filter((o) => savings.options.find((s) => s.id === o.id)?.savingsCents > 0).map((o) => `- ${o.text}`)
      : [];
    let plansText = '';
    if (approved) plansText = `\n\nYou already approved a plan for ${spike.category} this month: ${approved.description}.`;
    else if (!savings.flexible) plansText = `\n\nYou haven't marked ${spike.category} as a category you're willing to cut, so there are no plans for it.`;
    else if (plans.length) plansText = `\n\nWays to bring it back down:\n${plans.join('\n')}`;
    out.push({
      key: `spike:${spike.category}:${report.month}`,
      kind: 'spike',
      category: spike.category,
      month: report.month,
      subject: advice.headline,
      body: `${advice.explanation}${plansText}${footer(config)}`,
    });
  }
  for (const a of approvals) {
    const f = followThrough(db, a, { asOf: report.asOf });
    if (f?.status !== 'over') continue;
    const detail =
      f.kind === 'cap'
        ? `Since you approved it you've spent ${usd(f.spentCents)} on ${a.category}; the plan allowed ${usd(f.allowanceCents)} until ${dateLong(f.endsOn)}, so you're ${usd(-f.leftCents)} over.`
        : `${f.billedMerchants.join(' and ')} billed you after you planned to skip ${f.billedMerchants.length > 1 ? 'them' : 'it'}.`;
    out.push({
      key: `plan_over:${a.id}`,
      kind: 'plan_over',
      category: a.category,
      month: a.month,
      subject: `Your ${a.category} plan is off track`,
      body: `You approved this plan: ${a.description}, and moved ${usd(a.amountCents)} to savings.\n\n${detail}${footer(config)}`,
    });
  }
  return out;
}

// Sends each alert not sent yet (a failed one is retried up to MAX_ATTEMPTS times).
// The row is claimed as "sending" before the email goes out, so overlapping runs can't
// send the same alert twice.
export async function runAlerts(db, report, { config = emailConfig(), send = sendEmail } = {}) {
  if (!config.configured) return { configured: false, sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;
  for (const alert of await candidateAlerts(db, report, config)) {
    const row = db.prepare('SELECT status, attempts FROM alerts WHERE key = ?').get(alert.key);
    if (row && (row.status !== 'failed' || row.attempts >= MAX_ATTEMPTS)) continue;
    if (row) db.prepare("UPDATE alerts SET status = 'sending', attempts = attempts + 1 WHERE key = ?").run(alert.key);
    else {
      db.prepare("INSERT INTO alerts (key, kind, category, month, subject, body, status, attempts) VALUES (?, ?, ?, ?, ?, ?, 'sending', 1)")
        .run(alert.key, alert.kind, alert.category, alert.month, alert.subject, alert.body);
    }
    try {
      await send(alert, config);
      db.prepare("UPDATE alerts SET status = 'sent', error = NULL, sent_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE key = ?").run(alert.key);
      sent++;
    } catch (err) {
      db.prepare("UPDATE alerts SET status = 'failed', error = ? WHERE key = ?").run(err.message, alert.key);
      failed++;
    }
  }
  return { configured: true, sent, failed };
}

export const listAlerts = (db) =>
  db.prepare('SELECT key, kind, category, month, subject, status, attempts, error, created_at AS createdAt, sent_at AS sentAt FROM alerts ORDER BY created_at DESC LIMIT 20').all();
