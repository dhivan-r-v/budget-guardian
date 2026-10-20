import { useEffect, useRef, useState } from 'react';
import { api, usd, dateLong } from '../api.js';
import { Icon } from './Icons.jsx';

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const KIND = { purchase: 'Purchase', credit: 'Payment or refund', paypal: 'PayPal (already tracked)', foreign: 'Not USD', invalid: 'Unreadable' };
const ORDER = { YMD: 'year-month-day', MDY: 'month/day/year', DMY: 'day/month/year' };

function layoutText(l) {
  const amount =
    l.amountStyle === 'split' ? `money out in "${l.debitColumn}", money in in "${l.creditColumn}"`
      : l.amountStyle === 'typed' ? `amount in "${l.amountColumn}", purchases marked ${l.debitValues.map((v) => `"${v}"`).join(' or ')} in "${l.typeColumn}"`
        : `amount in "${l.amountColumn}", purchases are ${l.purchasesAre}`;
  return `Date in "${l.dateColumn}" (${ORDER[l.dateOrder]}), description in "${l.descriptionColumn}", ${amount}, ${l.currency}.`;
}

// Spending from any bank or card: upload the CSV statement its app exports. The AI reads
// the layout, code reads every amount, and the user checks a preview before importing.
export default function StatementUpload({ onChanged, onImported }) {
  const [file, setFile] = useState(null); // { name, text }
  const [preview, setPreview] = useState(null);
  const [imports, setImports] = useState(null);
  const [labeling, setLabeling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);

  const loadImports = async () => {
    const r = await api('/api/statements');
    setImports(r.imports);
    setLabeling(r.labeling || r.imports.some((i) => i.unlabeled > 0));
    return r;
  };
  useEffect(() => { loadImports().catch(() => setImports([])); }, []);
  // While new purchases are being labeled, check every few seconds, then refresh the page.
  useEffect(() => {
    if (!labeling) return undefined;
    let tries = 0;
    const t = setInterval(async () => {
      const r = await loadImports().catch(() => null);
      if (++tries > 15 || (r && !r.labeling)) {
        clearInterval(t);
        setLabeling(false);
        onChanged({});
      }
    }, 4000);
    return () => clearInterval(t);
  }, [labeling]);

  async function run(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const choose = (f) => run(async () => {
    if (!f) return;
    if (f.size > 1_000_000) throw new Error('This file is larger than 1 MB. Export a shorter period.');
    const text = await f.text();
    setFile({ name: f.name, text });
    setPreview(null);
    setPreview(await api('/api/statements/preview', json('POST', { text })));
  });
  const relayout = (change) => run(async () => {
    setPreview(await api('/api/statements/preview', json('POST', { text: file.text, layout: { ...preview.layout, ...change } })));
  });
  const doImport = () => run(async () => {
    const r = await api('/api/statements/import', json('POST', { text: file.text, layout: preview.layout, filename: file.name }));
    onImported(r.added ? `Imported ${r.added} purchases (${usd(r.addedCents)})` : 'Nothing new: these purchases were already imported');
    setFile(null);
    setPreview(null);
    if (input.current) input.current.value = '';
    await loadImports();
    onChanged({});
  });
  const remove = (id) => run(async () => {
    await api(`/api/statements/${id}`, { method: 'DELETE' });
    await loadImports();
    onChanged({});
  });

  const c = preview?.counts;
  return (
    <div className="card statement">
      <p className="muted">
        Track spending from any bank or credit card: export a statement as CSV from its app or website and upload it here.
        Budget Guardian finds the purchases and skips payments, refunds and PayPal payments it already tracks.
      </p>
      <div className="actions" style={{ marginTop: 12 }}>
        <label className="btn">
          <Icon name="bank" size={16} />{file ? 'Choose another file' : 'Upload a statement (CSV)'}
          <input ref={input} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => choose(e.target.files?.[0])} />
        </label>
        <a className="linkish" href="/api/statements/sample.csv" download>Download a sample card statement</a>
      </div>
      {busy && !preview && <p className="muted" style={{ marginTop: 10 }}>Reading the statement…</p>}

      {preview && (
        <div className="statement-preview">
          <div className="rescue-head">
            <strong>{file.name}</strong>
            <span className={`status-pill ${preview.source === 'ai' ? 'ok' : 'neutral'}`}>
              {preview.source === 'ai' ? 'Layout read by AI' : preview.source === 'user' ? 'Layout adjusted by you' : 'Layout read by rules'}
            </span>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>{layoutText(preview.layout)} Every amount is read by code.</p>
          <p style={{ marginTop: 10 }}>
            <strong>{c.purchases} purchases · {usd(preview.purchasesCents)}</strong>
            {preview.firstDate && <span className="muted"> · {dateLong(preview.firstDate)} to {dateLong(preview.lastDate)}</span>}
          </p>
          <p className="muted">
            Skipped: {c.credits} payments or refunds{c.paypal ? `, ${c.paypal} PayPal payments (already tracked)` : ''}{c.foreign ? `, ${c.foreign} not in USD` : ''}{c.invalid ? `, ${c.invalid} unreadable` : ''}.
          </p>
          <div className="table-wrap">
            <table className="mini-table">
              <thead><tr><th>Date</th><th>Merchant</th><th className="num">Amount</th><th>Read as</th></tr></thead>
              <tbody>
                {preview.sample.map((r, n) => (
                  <tr key={n} className={r.kind === 'purchase' ? '' : 'skipped'}>
                    <td>{r.date ? dateLong(r.date).replace(/, \d{4}$/, '') : '—'}</td>
                    <td title={r.description}>{r.merchant}</td>
                    <td className="num">{usd(r.cents)}</td>
                    <td>{KIND[r.kind]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.layout.amountStyle === 'single' && (
            <button type="button" className="linkish" style={{ marginTop: 8 }} disabled={busy} onClick={() => relayout({ purchasesAre: preview.layout.purchasesAre === 'negative' ? 'positive' : 'negative' })}>
              Purchases look wrong? Read {preview.layout.purchasesAre === 'negative' ? 'positive' : 'negative'} amounts as purchases instead
            </button>
          )}
          {preview.layout.currency !== 'USD' ? (
            <div className="callout warn">
              <Icon name="alert" size={18} />
              <span>
                These amounts look like <strong>{preview.layout.currency}</strong>. The sandbox works in US dollars only, so they can't be imported.{' '}
                <button type="button" className="linkish" disabled={busy} onClick={() => relayout({ currency: 'USD' })}>They are in USD</button>
              </span>
            </div>
          ) : (
            <div className="plan-actions">
              <p><Icon name="lock" size={14} /> Only the {c.purchases} purchases are added. You can remove this upload again.</p>
              <div className="actions">
                <button type="button" className="btn" disabled={busy || !c.purchases} onClick={doImport}>{busy ? 'Importing…' : `Import ${c.purchases} purchases`}</button>
                <button type="button" className="btn ghost" disabled={busy} onClick={() => { setFile(null); setPreview(null); if (input.current) input.current.value = ''; }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}

      {imports?.length > 0 && (
        <ul className="alert-list" style={{ marginTop: 16 }}>
          {imports.map((i) => (
            <li key={i.id}>
              <Icon name="bank" size={12} />
              <span className="grow">{i.filename} · {i.rowsAdded} purchases · {usd(i.totalCents)}{i.unlabeled > 0 && <span className="muted"> · labeling {i.unlabeled}…</span>}</span>
              <button type="button" className="linkish" disabled={busy} onClick={() => remove(i.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
