import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { detectSpikes } from '../src/spikes.js';
import { labelByRules } from '../src/categorizer.js';
import {
  parseCsv, parseDate, detectDateOrder, parseAmount, cleanMerchant, layoutByRules,
  previewStatement, importStatement, listImports, removeImport, sampleStatement,
} from '../src/statements.js';

const ASOF = '2026-10-20';
const CARD = `Card Statement,Visa ending 4821
Statement period,01/09/2026 to 20/10/2026

Trans. Date,Post Date,Details,Debit,Credit
02/10/2026,03/10/2026,SQ *BLUE BOTTLE COFFEE,"6.49",
05/10/2026,06/10/2026,"AMZN Mktp US*2K4, gift","1,299.99",
05/10/2026,06/10/2026,"AMZN Mktp US*2K4, gift","1,299.99",
11/10/2026,12/10/2026,PAYPAL *SHELLOIL,"42.10",
13/10/2026,14/10/2026,PAYMENT THANK YOU,,"600.00"
19/10/2026,20/10/2026,CHIPOTLE 2291,"12.92",
`;
const SIGNED = `Transaction Date,Description,Amount
10/02/2026,STARBUCKS STORE 123,-5.75
10/03/2026,AUTOMATIC PAYMENT - THANK,500.00
10/05/2026,SHELL OIL 5744,-48.20
10/09/2026,LYFT RIDE,-18.40
`;

test('reads CSV with quotes and account lines above the header', () => {
  const t = parseCsv(CARD);
  assert.deepEqual(t.header, ['Trans. Date', 'Post Date', 'Details', 'Debit', 'Credit']);
  assert.equal(t.rows.length, 6);
  assert.deepEqual(t.rows[1].slice(2, 4), ['AMZN Mktp US*2K4, gift', '1,299.99']);
  assert.deepEqual(parseCsv('a;b;c\n1;"x;y";3\n').rows, [['1', 'x;y', '3']]);
});

test('dates in many formats; the order is settled by the values', () => {
  for (const [v, order] of [['2026-10-05', 'YMD'], ['10/05/2026', 'MDY'], ['05/10/2026', 'DMY'], ['5 Oct 2026', 'MDY'], ['Oct 5, 2026', 'DMY'], ['05-OCT-26', 'YMD'], ['2026-10-05 14:22:00', 'YMD']]) {
    assert.equal(parseDate(v, order), '2026-10-05', v);
  }
  assert.equal(parseDate('31/02/2026', 'DMY'), null);
  assert.equal(detectDateOrder(['01/10/2026', '19/10/2026']), 'DMY'); // 19 can't be a month
  assert.equal(detectDateOrder(['01/02/2026', '03/04/2026']), 'MDY'); // ambiguous: US order
  assert.equal(detectDateOrder(['01/02/2026', '03/04/2026'], 'DMY'), 'DMY'); // ...unless the AI says otherwise
  assert.equal(detectDateOrder(['soon']), null);
});

test('amounts: separators, signs, DR/CR and other currencies', () => {
  const cents = (v) => parseAmount(v)?.cents ?? null;
  assert.equal(cents('$1,234.56'), 123456);
  assert.equal(cents('(12.34)'), -1234);
  assert.equal(cents('12.34-'), -1234);
  assert.equal(cents('1.234,56'), 123456);
  assert.equal(cents('abc'), null);
  assert.equal(parseAmount('12.34 DR').drcr, 'DR');
  assert.equal(parseAmount('₹500').foreign, true);
});

test('merchant names are cleaned from card descriptions', () => {
  assert.equal(cleanMerchant('SQ *BLUE BOTTLE COFFEE'), 'Blue Bottle Coffee');
  assert.equal(cleanMerchant('AMZN Mktp US*2K4L19'), 'Amazon');
  assert.equal(cleanMerchant('CHIPOTLE 2291'), 'Chipotle');
  assert.equal(cleanMerchant('TRADER JOE S #552'), 'Trader Joe S');
  assert.equal(cleanMerchant('UBER   *TRIP HELP.UBER.COM'), 'Uber');
});

test('rules read split and signed layouts, and the currency', () => {
  assert.deepEqual(layoutByRules(parseCsv(CARD)), { dateColumn: 'Trans. Date', descriptionColumn: 'Details', amountStyle: 'split', debitColumn: 'Debit', creditColumn: 'Credit', currency: 'USD' });
  assert.equal(layoutByRules(parseCsv(SIGNED)).purchasesAre, 'negative');
  assert.equal(layoutByRules(parseCsv('Txn Date,Narration,Withdrawal,Deposit\n02-10-2026,UPI-SWIGGY,350.00,\n')).currency, 'INR');
});

test('preview without AI: purchases found, payments and PayPal skipped', async () => {
  const p = await previewStatement(openDb(':memory:'), { text: CARD }, { useAI: false });
  assert.equal(p.source, 'rules');
  assert.equal(p.layout.dateOrder, 'DMY');
  assert.deepEqual(p.counts, { purchases: 4, credits: 1, paypal: 1, foreign: 0, invalid: 0 });
  assert.equal(p.purchasesCents, 649 + 129999 * 2 + 1292);
  assert.deepEqual([p.firstDate, p.lastDate], ['2026-10-02', '2026-10-19']);
});

test("the AI's layout is used only when it fits every row; otherwise rules", async () => {
  const db = openDb(':memory:');
  const good = { dateColumn: 'Transaction Date', dateOrder: 'MDY', descriptionColumn: 'Description', amountStyle: 'single', amountColumn: 'Amount', purchasesAre: 'negative', currency: 'USD' };
  const p = await previewStatement(db, { text: SIGNED }, { useAI: true, generate: async () => good });
  assert.equal(p.source, 'ai');
  assert.equal(p.counts.purchases, 3);
  // Cached by header: the same bank's next statement needs no AI call.
  const again = await previewStatement(db, { text: SIGNED }, { useAI: true, generate: async () => assert.fail('AI called again') });
  assert.equal(again.source, 'ai');

  const wrong = await previewStatement(openDb(':memory:'), { text: SIGNED }, { useAI: true, generate: async () => ({ ...good, amountColumn: 'Total' }) });
  assert.equal(wrong.source, 'rules');
  assert.match(wrong.aiError, /"Total" is not a column/);
  const down = await previewStatement(openDb(':memory:'), { text: SIGNED }, { useAI: true, generate: async () => { throw new Error('503'); } });
  assert.equal(down.source, 'rules');
  assert.equal(down.counts.purchases, 3);
});

test('the user can flip which sign means a purchase', async () => {
  const db = openDb(':memory:');
  const p = await previewStatement(db, { text: SIGNED }, { useAI: false });
  const flipped = await previewStatement(db, { text: SIGNED, layout: { ...p.layout, purchasesAre: 'positive' } });
  assert.equal(flipped.source, 'user');
  assert.equal(flipped.counts.purchases, 1);
  assert.equal(flipped.purchasesCents, 50000);
});

test('import adds purchases once, labels them, and they count toward spikes', async () => {
  const db = openDb(':memory:');
  const { layout } = await previewStatement(db, { text: CARD }, { useAI: false });
  const r = importStatement(db, { text: CARD, layout, filename: 'visa.csv' }, { asOf: ASOF });
  assert.equal(r.added, 4); // the two identical Amazon rows are two purchases
  assert.equal(r.addedCents, 649 + 129999 * 2 + 1292);
  assert.deepEqual(r.skipped, { credit: 1, paypal: 1, foreign: 0, invalid: 0 });

  const again = importStatement(db, { text: CARD, layout, filename: 'visa.csv' }, { asOf: ASOF });
  assert.equal(again.added, 0);
  assert.equal(again.alreadyImported, 4);
  assert.equal(listImports(db).length, 1);
  assert.equal(listImports(db)[0].unlabeled, 4);

  labelByRules(db);
  const shopping = detectSpikes(db, { asOf: ASOF }).categories.find((c) => c.category === 'shopping');
  assert.equal(shopping.currentCents, 259998);
  assert.equal(listImports(db)[0].unlabeled, 0);

  assert.deepEqual(removeImport(db, r.importId), { removed: 4 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE source = 'statement'").get().n, 0);
  assert.throws(() => removeImport(db, r.importId), { status: 404 });
});

test('purchases in the future or over 400 days old are not imported', () => {
  const db = openDb(':memory:');
  const text = 'Date,Description,Amount\n2026-10-25,FUTURE STORE,-10.00\n2025-01-01,OLD STORE,-10.00\n2026-10-10,NOW STORE,-10.00\n';
  const layout = { dateColumn: 'Date', dateOrder: 'YMD', descriptionColumn: 'Description', amountStyle: 'single', amountColumn: 'Amount', purchasesAre: 'negative', currency: 'USD' };
  const r = importStatement(db, { text, layout }, { asOf: ASOF });
  assert.equal(r.added, 1);
  assert.equal(r.outsideDates, 2);
});

test('statements in other currencies are refused', async () => {
  const db = openDb(':memory:');
  const text = 'Txn Date;Narration;Withdrawal (Dr);Deposit (Cr)\n02-10-2026;UPI-SWIGGY;350.00;\n05-10-2026;SALARY;;50000.00\n';
  const { layout } = await previewStatement(db, { text }, { useAI: false });
  assert.equal(layout.currency, 'INR');
  assert.throws(() => importStatement(db, { text, layout }, { asOf: ASOF }), { status: 422, message: /in INR, and Budget Guardian's sandbox works in USD only/ });
});

test('files that are not statements get a clear error', async () => {
  const db = openDb(':memory:');
  await assert.rejects(previewStatement(db, { text: 'hello\nworld\n' }, { useAI: false }), { status: 422 });
  await assert.rejects(previewStatement(db, { text: 'Name,Age,City\nAnn,30,Paris\n' }, { useAI: false }), { status: 422 });
  await assert.rejects(previewStatement(db, { text: '' }, { useAI: false }), { status: 400 });
});

test('the sample statement imports and makes the card spending spike', async () => {
  const db = openDb(':memory:');
  const text = sampleStatement(ASOF);
  const p = await previewStatement(db, { text }, { useAI: false });
  assert.equal(p.counts.invalid, 0);
  assert.ok(p.counts.purchases > 90);
  assert.ok(p.counts.paypal > 0);
  importStatement(db, { text, layout: p.layout }, { asOf: ASOF });
  labelByRules(db);
  const spikes = detectSpikes(db, { asOf: ASOF }).spikes.map((s) => s.category);
  assert.ok(spikes.includes('shopping'), spikes.join());
});
