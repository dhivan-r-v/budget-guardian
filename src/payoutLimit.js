// Limits on the public demo's real sandbox payouts. Every visitor gets their own demo copy
// (and can reset it), but all payouts come from the one sandbox account, so without limits a
// few eager clicks could drain it before judging ends. Two limits per UTC day, kept in the
// shared database: a total across everyone, and a number of approvals per visitor (by IP,
// since a reset gives the same visitor a fresh copy).
//
// reserve() is called before an approval is recorded, synchronously, so two approvals can't
// both slip under a limit; release() gives the amount back when PayPal refuses the payout.
import { ApprovalError } from './approvals.js';
import { usd } from './advisor.js';

export function createPayoutLimit(db, { dailyCents, perVisitorDaily = 8, now = () => new Date() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payout_limits (
      day     TEXT    NOT NULL,
      visitor TEXT    NOT NULL,
      cents   INTEGER NOT NULL DEFAULT 0,
      count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, visitor)
    )
  `);
  const today = () => now().toISOString().slice(0, 10);

  function reserve(amountCents, visitor = 'anonymous') {
    const day = today();
    const total = db.prepare('SELECT COALESCE(SUM(cents), 0) AS c FROM payout_limits WHERE day = ?').get(day).c;
    const mine = db.prepare('SELECT count FROM payout_limits WHERE day = ? AND visitor = ?').get(day, visitor)?.count ?? 0;
    if (mine >= perVisitorDaily) {
      throw new ApprovalError(429, `you've approved ${mine} plans today, this demo's daily limit per visitor, so nothing was moved. Everything else still works, and approvals open again tomorrow`);
    }
    if (total + amountCents > dailyCents) {
      throw new ApprovalError(429, `this demo has moved ${usd(total)} of its daily ${usd(dailyCents)} through PayPal today, so this ${usd(amountCents)} wasn't moved. Everything else still works, and approvals open again tomorrow`);
    }
    db.prepare(`
      INSERT INTO payout_limits (day, visitor, cents, count) VALUES (?, ?, ?, 1)
      ON CONFLICT (day, visitor) DO UPDATE SET cents = cents + excluded.cents, count = count + 1
    `).run(day, visitor, amountCents);
    return { day, visitor, amountCents };
  }

  function release(r) {
    if (!r) return;
    db.prepare('UPDATE payout_limits SET cents = MAX(0, cents - ?), count = MAX(0, count - 1) WHERE day = ? AND visitor = ?').run(r.amountCents, r.day, r.visitor);
  }

  const usedToday = () => db.prepare('SELECT COALESCE(SUM(cents), 0) AS c FROM payout_limits WHERE day = ?').get(today()).c;
  return { reserve, release, usedToday, dailyCents, perVisitorDaily };
}
