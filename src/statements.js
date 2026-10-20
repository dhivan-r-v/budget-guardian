// Statement upload: spending from any bank or card, from the CSV statement its app exports.
//
// Every bank lays its CSV out differently. The AI reads the header and a few rows and says
// which column holds the date, the description and the amount, and how purchases are told
// apart from payments and refunds. It never reads amounts: code parses every row with that
// layout and rejects it unless it holds up (dates and amounts parse, purchases found). If
// the AI's layout fails, or there's no API key, rules based on common header names are
// tried. The user sees a preview of what will be imported, can flip the sign if purchases
// were read backwards, and only then imports.
//
// Only purchases are imported, in US dollars (the sandbox currency). Payments, refunds,
// other currencies and PayPal payments (already tracked by the PayPal sync) are skipped.
// Rows already imported (same date, amount and description) are ignored, so uploading an
// overlapping statement adds nothing twice. Each upload can be removed again.
import { createHash, randomUUID } from 'node:crypto';
import { AI_MODEL, aiAvailable, generateJson } from './ai.js';
import { today } from './spikes.js';

export const MAX_BYTES = 1_000_000;
const MAX_ROWS = 5000;
const MAX_AGE_DAYS = 400; // older purchases don't affect the 6-month baseline
const PROMPT_VERSION = 1;

export class StatementError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// --- CSV

// RFC 4180: quoted fields may hold the delimiter, newlines and "" for a quote.
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field.trim() === '') { field = ''; quoted = true; }
    else if (c === delimiter) { row.push(field.trim()); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field.trim()); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ''));
}

// Banks put account details above the table, so the header is the first row that is as
// wide as most rows and holds no dates or amounts.
export function parseCsv(text) {
  const clean = text.replace(/^﻿/, '');
  const firstLines = clean.split(/\r?\n/).slice(0, 30).join('\n');
  const delimiter = [',', ';', '\t', '|'].map((d) => [d, firstLines.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = parseDelimited(clean, delimiter);
  const widths = {};
  for (const r of rows) widths[r.length] = (widths[r.length] ?? 0) + 1;
  const width = Number(Object.entries(widths).filter(([w]) => Number(w) >= 3).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0);
  if (!width) throw new StatementError(422, 'this file does not look like a statement table (fewer than 3 columns)');
  const headerAt = rows.findIndex((r) => r.length === width && r.every((f) => f === '' || (!parseDate(f, 'YMD') && !parseDate(f, 'MDY') && !parseDate(f, 'DMY') && parseAmount(f) === null)));
  if (headerAt < 0) throw new StatementError(422, 'could not find the header row (column names) in this file');
  const header = rows[headerAt].map((h, i) => h || `Column ${i + 1}`);
  const body = rows.slice(headerAt + 1).filter((r) => r.length === width);
  if (!body.length) throw new StatementError(422, 'the statement has no rows under its header');
  if (body.length > MAX_ROWS) throw new StatementError(413, `the statement has more than ${MAX_ROWS} rows; export a shorter period`);
  return { header, rows: body, delimiter };
}

// --- Dates: "2026-10-05", "10/05/2026", "05/10/2026", "5 Oct 2026", "Oct 5, 2026", "05-OCT-26"...

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export const DATE_ORDERS = ['YMD', 'MDY', 'DMY'];

export function parseDate(value, order) {
  const s = String(value).trim().replace(/[T\s]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?(Z|[+-]\d{2}:?\d{2})?$/i, '');
  const parts = s.split(/[\s/.,-]+/).filter(Boolean);
  if (parts.length !== 3) return null;
  const named = parts.findIndex((p) => /^[a-z]{3,9}$/i.test(p));
  let y;
  let m;
  let d;
  if (named >= 0) {
    // A month name settles the order; the year is the 4-digit (or last) part.
    m = MONTHS.indexOf(parts[named].slice(0, 3).toLowerCase()) + 1;
    if (!m) return null;
    const rest = parts.filter((_, i) => i !== named);
    const yi = rest.findIndex((p) => p.length === 4);
    [y, d] = yi >= 0 ? [rest[yi], rest[1 - yi]] : [rest[1], rest[0]];
  } else {
    if (!parts.every((p) => /^\d+$/.test(p))) return null;
    const at = Object.fromEntries([...order].map((k, i) => [k, parts[i]]));
    [y, m, d] = [at.Y, Number(at.M), at.D];
    if (order === 'YMD' && parts[0].length !== 4) return null;
  }
  if (!/^\d+$/.test(String(y)) || !/^\d{1,2}$/.test(String(d))) return null;
  const year = String(y).length === 2 ? 2000 + Number(y) : Number(y);
  if (String(y).length !== 2 && String(y).length !== 4) return null;
  const iso = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso ? null : iso;
}

// The order that reads every date; when several do (all days 12 or less), the hint's, else
// the US order.
export function detectDateOrder(values, hint) {
  const filled = values.filter((v) => String(v).trim());
  const ok = DATE_ORDERS.filter((o) => filled.length && filled.every((v) => parseDate(v, o)));
  if (!ok.length) return null;
  return ok.includes(hint) ? hint : ok.includes('MDY') ? 'MDY' : ok[0];
}

// --- Amounts: "$1,234.56", "-12.34", "(12.34)", "12.34-", "12.34 DR", "1.234,56", "₹500"

const FOREIGN = /[₹€£¥]|\b(rs\.?|inr|eur|gbp|jpy|cad|aud)\b/i;

export function parseAmount(value) {
  let s = String(value ?? '').trim();
  if (!s) return null;
  const foreign = FOREIGN.test(s);
  let sign = 1;
  let drcr = null;
  const tag = s.match(/\s*\b(DR|CR)\.?$/i);
  if (tag) { drcr = tag[1].toUpperCase(); s = s.slice(0, tag.index).trim(); }
  s = s.replace(FOREIGN, '').replace(/\$|\bUSD\b/gi, '').trim();
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1).trim(); }
  if (s.startsWith('-')) { sign = -sign; s = s.slice(1).trim(); }
  else if (s.endsWith('-')) { sign = -sign; s = s.slice(0, -1).trim(); }
  else if (s.startsWith('+')) s = s.slice(1).trim();
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$|^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56
  else s = s.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return { cents: sign * Math.round(Number(s) * 100), drcr, foreign };
}

// --- Merchant names: "SQ *BLUE BOTTLE COFFEE 123" -> "Blue Bottle Coffee"

const PREFIXES = /^(sq|tst|pp|sp|py|pos|dd|ach|chk|visa|mc|debit card purchase|purchase|card purchase|recurring payment)\s*\*?\s+|^(sq|tst|pp|sp|py)\s*\*/i;
const KNOWN = [[/amzn|amazon/i, 'Amazon'], [/netflix/i, 'Netflix'], [/spotify/i, 'Spotify'], [/uber\s*\*?\s*eats/i, 'Uber Eats'], [/\buber\b/i, 'Uber'], [/\blyft\b/i, 'Lyft'], [/apple\.com\/bill|itunes/i, 'Apple'], [/google\s*\*/i, 'Google']];

export function cleanMerchant(description) {
  const known = KNOWN.find(([re]) => re.test(description));
  if (known) return known[1];
  let s = description.replace(PREFIXES, '').replace(/\.com\b/gi, '').replace(/#\s*\d+/g, ' ').replace(/\b[A-Z]*\d[\dA-Z*-]{2,}\b/g, ' ').replace(/\*/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim() || description.trim();
  const words = s.split(' ').slice(0, 4).join(' ');
  return words.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 40);
}

// --- Layout (which column is what)
//   { dateColumn, descriptionColumn, amountStyle: 'single' | 'split' | 'typed',
//     amountColumn, purchasesAre: 'negative' | 'positive'      (single)
//     debitColumn, creditColumn                                 (split)
//     amountColumn, typeColumn, debitValues: ['DR', 'Debit']    (typed) }

const col = (header, name) => header.findIndex((h) => h.toLowerCase() === String(name ?? '').toLowerCase());

// Every row read with a layout. kind: purchase, credit (payment/refund/income), paypal
// (tracked by the PayPal sync), foreign (not USD), invalid.
export function readRows({ header, rows }, layout, dateOrder) {
  const at = (name) => col(header, name);
  const [di, ti, ai, ci, ki] = [at(layout.dateColumn), at(layout.descriptionColumn), at(layout.amountColumn ?? layout.debitColumn), at(layout.creditColumn), at(layout.typeColumn)];
  const debitValues = new Set((layout.debitValues ?? []).map((v) => String(v).trim().toLowerCase()));
  return rows.map((r) => {
    const date = parseDate(r[di], dateOrder);
    const description = (r[ti] ?? '').trim();
    let kind = 'invalid';
    let cents = 0;
    let foreign = false;
    if (layout.amountStyle === 'split') {
      const debit = parseAmount(r[ai]);
      const credit = parseAmount(r[ci]);
      foreign = Boolean(debit?.foreign || credit?.foreign);
      if (debit && debit.cents !== 0) { kind = 'purchase'; cents = Math.abs(debit.cents); }
      else if (credit && credit.cents !== 0) { kind = 'credit'; cents = Math.abs(credit.cents); }
    } else {
      const a = parseAmount(r[ai]);
      if (a && a.cents !== 0) {
        foreign = a.foreign;
        cents = Math.abs(a.cents);
        let purchase;
        if (layout.amountStyle === 'typed') purchase = debitValues.has(String(r[ki] ?? '').trim().toLowerCase());
        else if (a.drcr) purchase = a.drcr === 'DR';
        else purchase = layout.purchasesAre === 'negative' ? a.cents < 0 : a.cents > 0;
        kind = purchase ? 'purchase' : 'credit';
      }
    }
    if (!date || !description) kind = 'invalid';
    else if (kind === 'purchase' && foreign) kind = 'foreign';
    else if (kind === 'purchase' && /paypal/i.test(description)) kind = 'paypal';
    return { date, description, merchant: description ? cleanMerchant(description) : '', cents, kind };
  });
}

// Checks a layout against the whole file. Returns { errors } or { dateOrder, rows }.
export function checkLayout(table, layout, hintOrder) {
  const errors = [];
  const { header } = table;
  const need = ['dateColumn', 'descriptionColumn', ...(layout?.amountStyle === 'split' ? ['debitColumn', 'creditColumn'] : ['amountColumn']), ...(layout?.amountStyle === 'typed' ? ['typeColumn'] : [])];
  if (!['single', 'split', 'typed'].includes(layout?.amountStyle)) errors.push('amountStyle must be single, split or typed');
  for (const k of need) if (col(header, layout?.[k]) < 0) errors.push(`${k} "${layout?.[k]}" is not a column`);
  if (layout?.amountStyle === 'single' && !['negative', 'positive'].includes(layout.purchasesAre)) errors.push('purchasesAre must be negative or positive');
  if (layout?.amountStyle === 'typed' && !(Array.isArray(layout.debitValues) && layout.debitValues.length)) errors.push('debitValues are required');
  if (!/^[A-Z]{3}$/.test(layout?.currency ?? '')) errors.push('currency must be a 3-letter code like USD');
  if (errors.length) return { errors };

  const dateOrder = detectDateOrder(table.rows.map((r) => r[col(header, layout.dateColumn)]), hintOrder);
  if (!dateOrder) return { errors: [`"${layout.dateColumn}" does not hold dates in every row`] };
  const rows = readRows(table, layout, dateOrder);
  const invalid = rows.filter((r) => r.kind === 'invalid').length;
  if (invalid > rows.length * 0.1) errors.push(`${invalid} of ${rows.length} rows have no readable amount or description`);
  if (!rows.some((r) => r.kind === 'purchase')) errors.push('no purchases found with this layout');
  return errors.length ? { errors } : { dateOrder, rows };
}

const HEADER_RULES = {
  date: [/^(trans(action)?\.?\s*date|txn\s*date|date)$/i, /date/i],
  description: [/^(description|details|narration|particulars|merchant|payee|transaction details|name)$/i, /desc|detail|narration|particular|merchant|payee|memo|name/i],
  amount: [/^(amount|transaction amount|amt|value)$/i, /amount|amt/i],
  debit: [/^(debit|withdrawals?|withdrawal amt\.?|money out|paid out|dr)$/i, /debit|withdraw|money out|paid out/i],
  credit: [/^(credit|deposits?|deposit amt\.?|money in|paid in|cr)$/i, /credit|deposit|money in|paid in/i],
  type: [/^(type|transaction type|dr\/cr|cr\/dr|debit\/credit)$/i],
};
const findHeader = (header, rules) => {
  for (const re of rules) {
    const h = header.find((x) => re.test(x));
    if (h) return h;
  }
  return null;
};

// The fallback when the AI isn't available or its layout fails: common header names.
export function layoutByRules(table) {
  const { header, rows } = table;
  const text = `${header.join(' ')} ${rows.slice(0, 50).flat().join(' ')}`;
  const currency = /₹|\bINR\b|\bRs\.?\s?\d|\bUPI\b|\bNEFT\b|\bIMPS\b/i.test(text) ? 'INR' : /€|\bEUR\b/.test(text) ? 'EUR' : /£|\bGBP\b/.test(text) ? 'GBP' : 'USD';
  const dateColumn = findHeader(header, HEADER_RULES.date);
  const descriptionColumn = findHeader(header, HEADER_RULES.description);
  const debitColumn = findHeader(header, HEADER_RULES.debit);
  const creditColumn = findHeader(header, HEADER_RULES.credit);
  if (debitColumn && creditColumn && debitColumn !== creditColumn) return { dateColumn, descriptionColumn, amountStyle: 'split', debitColumn, creditColumn, currency };
  const amountColumn = findHeader(header, HEADER_RULES.amount);
  const typeColumn = findHeader(header, HEADER_RULES.type);
  if (amountColumn && typeColumn) {
    const values = [...new Set(rows.map((r) => r[col(header, typeColumn)]))];
    const debitValues = values.filter((v) => /^(dr|debit|d|withdrawal|purchase|sale)$/i.test(String(v).trim()));
    if (debitValues.length) return { dateColumn, descriptionColumn, amountStyle: 'typed', amountColumn, typeColumn, debitValues, currency };
  }
  // One signed amount column: purchases are the more common sign (payments and refunds are
  // fewer than purchases on almost every statement).
  const amounts = amountColumn ? rows.map((r) => parseAmount(r[col(header, amountColumn)])).filter(Boolean) : [];
  const negatives = amounts.filter((a) => a.cents < 0).length;
  return { dateColumn, descriptionColumn, amountStyle: 'single', amountColumn, purchasesAre: negatives > amounts.length / 2 ? 'negative' : 'positive', currency };
}

const LAYOUT_SCHEMA = {
  type: 'object',
  properties: {
    dateColumn: { type: 'string', description: 'the purchase/transaction date (not the posting date if both exist)' },
    dateOrder: { type: 'string', enum: DATE_ORDERS, description: 'order of year (Y), month (M) and day (D) in numeric dates' },
    descriptionColumn: { type: 'string', description: 'merchant or transaction description' },
    amountStyle: { type: 'string', enum: ['single', 'split', 'typed'] },
    amountColumn: { type: 'string' },
    purchasesAre: { type: 'string', enum: ['negative', 'positive'] },
    debitColumn: { type: 'string' },
    creditColumn: { type: 'string' },
    typeColumn: { type: 'string' },
    debitValues: { type: 'array', items: { type: 'string' } },
    currency: { type: 'string', description: 'ISO code of the amounts, e.g. USD, INR, EUR' },
  },
  required: ['dateColumn', 'descriptionColumn', 'amountStyle', 'currency'],
};

const SYSTEM = `You read the layout of a bank or credit card statement exported as CSV. You get the column names and a few rows.
Say which column holds what, using the exact column names:
- dateColumn: when the purchase happened. If there is both a transaction date and a posting date, pick the transaction date. dateOrder: the order of Y, M, D in its numeric dates.
- descriptionColumn: the merchant or transaction description.
- amountStyle:
  - "single": one signed amount column (amountColumn). purchasesAre: "negative" if purchases (money spent) are negative numbers, "positive" if they are positive (common on credit card statements, where payments are negative).
  - "split": separate columns for money out (debitColumn) and money in (creditColumn).
  - "typed": one unsigned amount column (amountColumn) plus a type column (typeColumn); debitValues are the exact type values that mean money spent (e.g. "DR", "Debit").
- currency: the ISO code the amounts are in. Judge from symbols, column names and context (e.g. UPI references, NEFT, Indian bank formats mean INR). Use USD only when that is the most likely currency.
Only describe the layout. Do not copy or compute any amounts.`;

async function aiLayout(db, table, generate) {
  const key = createHash('sha256').update(JSON.stringify({ statementLayout: PROMPT_VERSION, model: AI_MODEL, header: table.header })).digest('hex');
  const cached = db.prepare('SELECT response FROM ai_cache WHERE key = ?').get(key);
  if (cached) return { layout: JSON.parse(cached.response), key };
  const sample = table.rows.slice(0, 5).map((r) => Object.fromEntries(table.header.map((h, i) => [h, r[i]])));
  const layout = await generate({ system: SYSTEM, prompt: `Columns: ${JSON.stringify(table.header)}\nRows:\n${sample.map((r) => JSON.stringify(r)).join('\n')}`, schema: LAYOUT_SCHEMA });
  return { layout, key };
}

// --- Preview and import

function summarize(rows, layout, dateOrder, source, aiError) {
  const count = (k) => rows.filter((r) => r.kind === k).length;
  const purchases = rows.filter((r) => r.kind === 'purchase');
  const dates = purchases.map((r) => r.date).sort();
  return {
    layout: { ...layout, dateOrder },
    source,
    ...(aiError && { aiError }),
    counts: { purchases: purchases.length, credits: count('credit'), paypal: count('paypal'), foreign: count('foreign'), invalid: count('invalid') },
    purchasesCents: purchases.reduce((s, r) => s + r.cents, 0),
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
    sample: rows.slice(0, 8).map(({ date, merchant, description, cents, kind }) => ({ date, merchant, description, cents, kind })),
  };
}

// Works out the layout (AI, then rules) unless one is given, and returns what would be imported.
export async function previewStatement(db, { text, layout } = {}, { generate = generateJson, useAI = aiAvailable() } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new StatementError(400, 'the file is empty');
  if (Buffer.byteLength(text) > MAX_BYTES) throw new StatementError(413, 'the file is larger than 1 MB; export a shorter period');
  const table = parseCsv(text);
  const base = { columns: table.header, rowCount: table.rows.length };

  if (layout) {
    const checked = checkLayout(table, layout, layout.dateOrder);
    if (checked.errors) throw new StatementError(422, checked.errors[0], { ...base, errors: checked.errors });
    return { ...base, ...summarize(checked.rows, layout, checked.dateOrder, 'user') };
  }
  let aiError = null;
  if (useAI) {
    try {
      const { layout: guess, key } = await aiLayout(db, table, generate);
      const checked = checkLayout(table, guess, guess.dateOrder);
      if (!checked.errors) {
        db.prepare('INSERT OR REPLACE INTO ai_cache (key, model, response) VALUES (?, ?, ?)').run(key, AI_MODEL, JSON.stringify(guess));
        return { ...base, ...summarize(checked.rows, guess, checked.dateOrder, 'ai') };
      }
      aiError = `the AI's layout didn't fit the file: ${checked.errors[0]}`;
    } catch (err) {
      aiError = err.message;
    }
  }
  const guess = layoutByRules(table);
  const checked = checkLayout(table, guess);
  if (checked.errors) throw new StatementError(422, `couldn't read this statement's layout: ${checked.errors[0]}`, { ...base, errors: checked.errors, aiError });
  return { ...base, ...summarize(checked.rows, guess, checked.dateOrder, 'rules', aiError) };
}

// Imports the purchases with a layout the user saw in the preview. Rows are identified by
// date, amount, description and how many identical rows came before in the file, so the same
// purchase in two overlapping statements is stored once.
export function importStatement(db, { text, layout, filename }, { asOf = today() } = {}) {
  if (!layout) throw new StatementError(400, 'layout is required (from the preview)');
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new StatementError(413, 'the file is larger than 1 MB');
  const table = parseCsv(text);
  const checked = checkLayout(table, layout, layout.dateOrder);
  if (checked.errors) throw new StatementError(422, checked.errors[0], { errors: checked.errors });
  // The app works in one currency (the sandbox's USD); mixing in other currencies would make
  // every total wrong, and converting would need exchange rates per day.
  if (layout.currency !== 'USD') throw new StatementError(422, `this statement is in ${layout.currency}, and Budget Guardian's sandbox works in USD only, so nothing was imported`);

  const oldest = new Date(Date.parse(`${asOf}T00:00:00Z`) - MAX_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const purchases = checked.rows.filter((r) => r.kind === 'purchase');
  const kept = purchases.filter((r) => r.date <= asOf && r.date >= oldest);
  const importId = randomUUID();
  const seen = new Map();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO transactions (id, occurred_at, amount_cents, currency, merchant, description, source, import_id)
    VALUES (?, ?, ?, 'USD', ?, ?, 'statement', ?)
  `);
  let added = 0;
  let total = 0;
  const dates = [];
  db.exec('BEGIN');
  try {
    for (const r of kept) {
      const base = `${r.date}|${r.cents}|${r.description.toLowerCase()}`;
      const nth = (seen.get(base) ?? 0) + 1;
      seen.set(base, nth);
      const id = `stmt-${createHash('sha256').update(`${base}|${nth}`).digest('hex').slice(0, 24)}`;
      if (insert.run(id, `${r.date}T12:00:00Z`, r.cents, r.merchant, r.description, importId).changes) {
        added++;
        total += r.cents;
        dates.push(r.date);
      }
    }
    if (added) {
      dates.sort();
      db.prepare('INSERT INTO statement_imports (id, filename, rows_added, total_cents, first_date, last_date) VALUES (?, ?, ?, ?, ?, ?)')
        .run(importId, String(filename || 'statement.csv').slice(0, 120), added, total, dates[0], dates.at(-1));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return {
    importId: added ? importId : null,
    added,
    addedCents: total,
    alreadyImported: kept.length - added,
    outsideDates: purchases.length - kept.length,
    skipped: Object.fromEntries(['credit', 'paypal', 'foreign', 'invalid'].map((k) => [k, checked.rows.filter((r) => r.kind === k).length])),
  };
}

export function listImports(db) {
  return db.prepare(`
    SELECT i.id, i.filename, i.rows_added AS rowsAdded, i.total_cents AS totalCents, i.first_date AS firstDate, i.last_date AS lastDate,
           i.created_at AS createdAt, (SELECT COUNT(*) FROM transactions t WHERE t.import_id = i.id AND t.category IS NULL) AS unlabeled
    FROM statement_imports i ORDER BY i.created_at DESC
  `).all();
}

export function removeImport(db, id) {
  const removed = db.prepare('DELETE FROM transactions WHERE import_id = ?').run(id).changes;
  const existed = db.prepare('DELETE FROM statement_imports WHERE id = ?').run(id).changes;
  if (!existed) throw new StatementError(404, 'import not found');
  return { removed: Number(removed) };
}

// --- A sample card statement ending today, for trying the feature (and the demo).
// Laid out the way many banks do it: account lines above the table, day-first dates,
// separate Debit and Credit columns, card-network merchant names.
export function sampleStatement(end = today(), seed = 7) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const endDate = new Date(`${end}T00:00:00Z`);
  const start = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - 3, 1));
  const lines = [];
  const add = (d, details, debit, credit) => lines.push({ d, details, debit, credit });
  const merchants = [
    ['SQ *BLUE BOTTLE COFFEE', 450, 650, 0.35],
    ['CHIPOTLE 2291', 1100, 1600, 0.12],
    ['TRADER JOE S #552', 3500, 7500, 0.12],
    ['UBER   *TRIP HELP.UBER.COM', 1200, 2600, 0.1],
    ['AMZN Mktp US*2K4L19', 1500, 4500, 0.08],
  ];
  for (let d = new Date(start); d <= endDate; d = new Date(d.getTime() + 86_400_000)) {
    const day = d.getUTCDate();
    for (const [name, lo, hi, p] of merchants) if (rand() < p) add(new Date(d), name, lo + Math.round(rand() * (hi - lo)), null);
    if (day === 7) add(new Date(d), 'NETFLIX.COM', 1549, null);
    if (day === 15) add(new Date(d), 'VERIZON WIRELESS', 6500, null);
    if (day === 20) add(new Date(d), 'PAYMENT THANK YOU', null, 60000);
    if (day === 11 && rand() < 0.5) add(new Date(d), 'PAYPAL *SHELLOIL', 4210, null);
  }
  // This month: a new laptop and a concert, so the card's shopping and entertainment spike.
  const thisMonth = (day) => new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), Math.min(day, endDate.getUTCDate())));
  add(thisMonth(2), 'BEST BUY 00012385', 74999, null);
  add(thisMonth(3), 'TICKETMASTER *CONCERT', 18900, null);
  add(thisMonth(4), 'AMZN Mktp US RETURN', null, 2399);
  lines.sort((a, b) => a.d - b.d);
  const fmt = (d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
  const money = (c) => (c === null ? '' : `"${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}"`);
  return [
    'Card Statement,Visa Signature ending 4821',
    `Statement period,${fmt(start)} to ${fmt(endDate)}`,
    '',
    'Trans. Date,Post Date,Details,Debit,Credit',
    ...lines.map((l) => `${fmt(l.d)},${fmt(new Date(l.d.getTime() + 86_400_000))},${l.details},${money(l.debit)},${money(l.credit)}`),
  ].join('\n') + '\n';
}
