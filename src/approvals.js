// The approval step: nothing moves until the user approves one savings option, and then
// only the amount the server itself recomputes.
//
// approve() re-derives the option from current data and refuses if the amount differs from
// what the user saw, records the approval, and only then sends a PayPal Payout of the saved
// amount to the user's savings account. The approval id is the payout's sender_batch_id,
// which PayPal will not pay twice, so retrying an unsent approval is always safe.
//
// Before anything moves, the PayPal balance is checked so moving money to savings never
// leaves the account below a cushion. Each approval also records the plan behind it (how
// much the category may still take this month, or which subscriptions to skip), so
// followThrough() can later tell the user whether they kept it.
import { randomUUID } from 'node:crypto';
import { detectSpikes, today } from './spikes.js';
import { suggestSavings } from './savings.js';
import { usd } from './advisor.js';
import * as paypalClient from './paypal.js';

export class ApprovalError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const FAILED_ITEM_STATUSES = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED']);

// Money that must stay in the PayPal account after a transfer to savings, in cents.
export const minBalanceCents = () => Math.round(Number(process.env.MIN_BALANCE_AFTER_SAVINGS || 50) * 100);

const toApproval = (r) =>
  r && {
    id: r.id,
    optionId: r.option_id,
    category: r.category,
    month: r.month,
    description: r.description,
    amountCents: r.amount_cents,
    receiver: r.receiver,
    status: r.status,
    payoutBatchId: r.payout_batch_id,
    paypalStatus: r.paypal_status,
    error: r.error,
    planSince: r.plan_since ?? null,
    planAllowanceCents: r.plan_allowance_cents ?? null,
    planMerchants: r.plan_merchants ? JSON.parse(r.plan_merchants) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };

export const getApproval = (db, id) => toApproval(db.prepare('SELECT * FROM approvals WHERE id = ?').get(id));
export const listApprovals = (db) => db.prepare('SELECT * FROM approvals ORDER BY created_at DESC, id').all().map(toApproval);

export function describe(category, o) {
  if (o.type === 'public_transport') return `Public transport instead of driving on ${o.transitDays} days`;
  if (o.type === 'skip_subscriptions') {
    const names = o.subscriptions.filter((s) => !s.chargedThisMonth).map((s) => s.merchant);
    return `Skip ${names.join(' and ')} this month`;
  }
  return `Spend ${o.percent}% less on ${category} for the rest of the month`;
}

// Re-derives an option from current data. Never trusts amounts sent by the client.
export function resolveOption(db, optionId, { asOf } = {}) {
  if (typeof optionId !== 'string' || !optionId.includes(':')) throw new ApprovalError(400, 'optionId is required');
  const category = optionId.split(':')[0];
  const report = detectSpikes(db, asOf ? { asOf } : {});
  const entry = report.categories.find((c) => c.category === category);
  if (!entry) throw new ApprovalError(404, `no spending found in category "${category}"`);
  const savings = suggestSavings(db, report, entry);
  if (!savings.flexible) throw new ApprovalError(403, `"${category}" is not marked as flexible`);
  const option = savings.options.find((o) => o.id === optionId);
  if (!option) throw new ApprovalError(404, 'this option is no longer available');
  return { month: report.month, category, option, description: describe(category, option), plan: planFor(report, savings, option) };
}

// What the plan leaves the category for the rest of the month, using the same figures the
// saving was computed from: the current daily fuel rate for transit days, the usual rest of
// the month for cutting back. Skipping subscriptions is checked merchant by merchant instead.
function planFor(report, savings, option) {
  const remainingDays = report.daysInMonth - report.daysElapsed;
  if (option.type === 'public_transport') {
    return { allowanceCents: Math.max(0, savings.assumptions.dailyFuelCents * remainingDays - option.fuelAvoidedCents), merchants: null };
  }
  if (option.type === 'cut_back') {
    return { allowanceCents: Math.max(0, savings.assumptions.usualRemainingCents - option.savingsCents), merchants: null };
  }
  return { allowanceCents: null, merchants: option.subscriptions.filter((s) => !s.chargedThisMonth).map((s) => s.merchant) };
}

const isoSeconds = (d) => d.toISOString().slice(0, 19) + 'Z';

// Refuses (before anything is recorded) if the transfer would leave the PayPal account below
// the cushion. PayPal's balance lags behind, so transfers approved since its last refresh are
// subtracted too. If the balance can't be read, nothing moves.
async function checkBalance(db, amountCents, client) {
  let balance;
  try {
    balance = await client.getBalance();
  } catch (err) {
    throw new ApprovalError(503, `couldn't check your PayPal balance, so nothing was moved (${err.message}). Try again in a minute`);
  }
  const inFlight = balance.refreshedAt
    ? db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS c FROM approvals WHERE status != 'failed' AND created_at > ?").get(isoSeconds(new Date(balance.refreshedAt))).c
    : 0;
  const availableCents = balance.availableCents - inFlight;
  const cushion = minBalanceCents();
  if (availableCents - amountCents < cushion) {
    throw new ApprovalError(
      422,
      `your PayPal balance is ${usd(Math.max(0, availableCents))}, and moving ${usd(amountCents)} would leave less than the ${usd(cushion)} you keep for spending, so nothing was moved`,
      { availableCents, minBalanceCents: cushion },
    );
  }
}

const setStatus = (db, id, fields) => {
  const cols = Object.keys(fields);
  db.prepare(`UPDATE approvals SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), id);
};

// Sends the payout for an approval in status "approved". A refusal from PayPal (4xx) is
// final; a network error or PayPal 5xx leaves it "approved" so it can be retried with the
// same id, which PayPal guarantees won't pay twice.
async function send(db, approval, client) {
  try {
    const p = await client.createPayout({
      senderBatchId: approval.id,
      receiver: approval.receiver,
      amountCents: approval.amountCents,
      subject: 'Budget Guardian moved money to your savings',
      note: `Budget Guardian: ${approval.description}. Saved ${usd(approval.amountCents)}.`,
    });
    setStatus(db, approval.id, { status: 'sent', payout_batch_id: p.payoutBatchId, paypal_status: p.batchStatus, error: null });
  } catch (err) {
    const refused = err.status >= 400 && err.status < 500;
    const name = err.details?.name ? `${err.details.name}: ` : '';
    setStatus(db, approval.id, { status: refused ? 'failed' : 'approved', error: `${name}${err.message}` });
  }
  return getApproval(db, approval.id);
}

export async function approve(db, { optionId, expectedAmountCents, asOf } = {}, { client = paypalClient, receiver = process.env.SAVINGS_RECEIVER_EMAIL?.trim(), now = new Date() } = {}) {
  if (!receiver) throw new ApprovalError(503, 'SAVINGS_RECEIVER_EMAIL is not set in .env');
  if (!Number.isInteger(expectedAmountCents)) throw new ApprovalError(400, 'expectedAmountCents must be the amount shown to the user, in cents');

  const { month, category, option, description, plan } = resolveOption(db, optionId, { asOf });
  const amountCents = option.savingsCents;
  if (amountCents <= 0) throw new ApprovalError(409, 'this option has nothing to save right now');
  if (amountCents !== expectedAmountCents) {
    throw new ApprovalError(409, `the amount changed to ${usd(amountCents)}; please review it again`, { amountCents });
  }

  // A category's options are alternatives (2 or 3 transit days, not both), so each category
  // gets one live plan per month. Checked before and again after the balance lookup: the
  // second check and the insert run without awaiting in between, so two clicks can't both
  // get past here.
  const livePlan = () => {
    const live = db.prepare("SELECT * FROM approvals WHERE category = ? AND month = ? AND status != 'failed'").get(category, month);
    if (live?.option_id === optionId) return { approval: toApproval(live), duplicate: true };
    if (live) {
      throw new ApprovalError(409, `you already approved a ${category} plan this month: ${live.description}`, { approvalId: live.id });
    }
    return null;
  };
  const before = livePlan();
  if (before) return before;
  await checkBalance(db, amountCents, client);
  const after = livePlan();
  if (after) return after;
  // The plan starts now, or at the end of `asOf` when approving for an earlier date.
  const endOfDay = `${asOf ?? today()}T23:59:59Z`;
  const planSince = isoSeconds(now) < endOfDay ? isoSeconds(now) : endOfDay;
  const id = randomUUID();
  db.prepare(`
    INSERT INTO approvals (id, option_id, category, month, description, amount_cents, receiver, status, plan_since, plan_allowance_cents, plan_merchants)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)
  `).run(id, optionId, category, month, description, amountCents, receiver, planSince, plan.allowanceCents, plan.merchants && JSON.stringify(plan.merchants));

  return { approval: await send(db, getApproval(db, id), client), duplicate: false };
}

// Resends an approval whose payout never got through (status "approved").
export async function retry(db, id, { client = paypalClient } = {}) {
  const approval = getApproval(db, id);
  if (!approval) throw new ApprovalError(404, 'approval not found');
  if (approval.status !== 'approved') throw new ApprovalError(409, `approval is ${approval.status}; only unsent approvals can be retried`);
  return send(db, approval, client);
}

// Asks PayPal for the latest status of a sent payout.
export async function refresh(db, id, { client = paypalClient } = {}) {
  const approval = getApproval(db, id);
  if (!approval) throw new ApprovalError(404, 'approval not found');
  if (approval.status !== 'sent' || !approval.payoutBatchId) return approval;
  const p = await client.getPayout(approval.payoutBatchId);
  const paypalStatus = p.itemStatus ?? p.batchStatus;
  let status = 'sent';
  if (p.itemStatus === 'SUCCESS') status = 'completed';
  else if (FAILED_ITEM_STATUSES.has(p.itemStatus) || p.batchStatus === 'DENIED' || p.batchStatus === 'CANCELED') status = 'failed';
  setStatus(db, id, { status, paypal_status: paypalStatus });
  return getApproval(db, id);
}

// Did the user keep the plan? Compares spending in the plan's category since it was approved
// with what the plan allows (or, for skipped subscriptions, whether any of them billed).
//   on_track: within the plan so far      over:   already spent more than the plan allows
//   kept:     the month ended within it   missed: the month ended over it
// Returns null for failed approvals and ones made before plans were recorded.
export function followThrough(db, approval, { asOf = today() } = {}) {
  if (!approval.planSince || approval.status === 'failed') return null;
  const [y, m] = approval.month.split('-').map(Number);
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const endsOn = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const monthEnded = asOf >= nextMonth;
  const upTo = monthEnded ? nextMonth : new Date(Date.parse(`${asOf}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const since = approval.planSince;
  const status = (broken) => (broken ? (monthEnded ? 'missed' : 'over') : monthEnded ? 'kept' : 'on_track');

  if (approval.planMerchants) {
    const names = approval.planMerchants;
    const billed = names.length
      ? db.prepare(`
          SELECT DISTINCT merchant FROM transactions
          WHERE COALESCE(category, seed_category) = ? AND COALESCE(is_recurring, seed_recurring, 0) = 1
            AND occurred_at > ? AND occurred_at < ? AND merchant IN (${names.map(() => '?').join(', ')})
        `).all(approval.category, since, upTo, ...names).map((r) => r.merchant)
      : [];
    return { kind: 'skip', merchants: names, billedMerchants: billed, endsOn, monthEnded, status: status(billed.length > 0) };
  }

  const spentCents = db.prepare(`
    SELECT COALESCE(SUM(amount_cents), 0) AS c FROM transactions
    WHERE COALESCE(category, seed_category) = ? AND COALESCE(is_recurring, seed_recurring, 0) = 0
      AND occurred_at > ? AND occurred_at < ?
  `).get(approval.category, since, upTo).c;
  const allowanceCents = approval.planAllowanceCents;
  return { kind: 'cap', allowanceCents, spentCents, leftCents: allowanceCents - spentCents, endsOn, monthEnded, status: status(spentCents > allowanceCents) };
}

export const withFollowThrough = (db, approval, opts) => approval && { ...approval, followThrough: followThrough(db, approval, opts) };
