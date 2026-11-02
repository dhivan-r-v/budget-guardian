import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// Plaid's own script, loaded only when the user connects an account.
let plaidScript;
function loadPlaid() {
  plaidScript ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    s.onload = () => resolve(window.Plaid);
    s.onerror = () => { plaidScript = null; reject(new Error("Couldn't load Plaid. Check your connection and try again.")); };
    document.head.appendChild(s);
  });
  return plaidScript;
}

const ago = (iso) => {
  if (!iso) return 'not synced yet';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'synced just now' : m < 60 ? `synced ${m} min ago` : `synced ${Math.round(m / 60)} h ago`;
};

// Banks and credit cards connected through Plaid: their spending syncs automatically.
export default function PlaidConnect({ onChanged, onConnected }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [waiting, setWaiting] = useState(false);

  const load = async () => {
    const s = await api('/api/plaid/status');
    setStatus(s);
    return s;
  };
  useEffect(() => { load().catch(() => setStatus({ configured: false, items: [] })); }, []);
  // Right after connecting, Plaid prepares the history; check until transactions arrive.
  useEffect(() => {
    if (!waiting) return undefined;
    let tries = 0;
    const t = setInterval(async () => {
      const s = await load().catch(() => null);
      if (++tries > 20 || s?.items.some((i) => i.transactions > 0)) {
        clearInterval(t);
        setWaiting(false);
        onChanged({});
      }
    }, 5000);
    return () => clearInterval(t);
  }, [waiting]);

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

  const connect = () => run(async () => {
    const [Plaid, { linkToken }] = await Promise.all([loadPlaid(), api('/api/plaid/link-token', { method: 'POST' })]);
    await new Promise((resolve, reject) => {
      const handler = Plaid.create({
        token: linkToken,
        onSuccess: async (publicToken, metadata) => {
          try {
            await api('/api/plaid/exchange', json('POST', { publicToken, institution: metadata?.institution?.name }));
            onConnected(`${metadata?.institution?.name ?? 'Account'} connected. Fetching transactions…`);
            setWaiting(true);
            await load();
            resolve();
          } catch (err) {
            reject(err);
          }
        },
        onExit: (err) => (err ? reject(new Error(err.display_message || err.error_message || 'Plaid closed with an error')) : resolve()),
      });
      handler.open();
    });
  });
  const sync = () => run(async () => {
    await api('/api/plaid/sync', { method: 'POST' });
    await load();
    onChanged({});
  });
  const remove = (id) => run(async () => {
    await api(`/api/plaid/items/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await load();
    onChanged({});
  });

  if (!status) return null;
  if (!status.configured) {
    return <p className="muted">Automatic bank and card connections (Plaid) aren't set up on this server. You can still upload a statement below.</p>;
  }
  return (
    <div>
      <p className="muted">
        Connect a bank account or credit card and its spending syncs automatically. You log in to your bank in Plaid's own window; Budget Guardian never sees your login.
        {status.env === 'sandbox' && <> This is Plaid's sandbox: use the test login <strong>user_transactions_dynamic</strong> with any password.</>}
      </p>
      <div className="actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn" disabled={busy} onClick={connect}><Icon name="bank" size={16} />{busy ? 'Opening Plaid…' : 'Connect a bank or credit card'}</button>
        {status.items.length > 0 && <button type="button" className="btn ghost" disabled={busy} onClick={sync}><Icon name="refresh" size={14} />Sync now</button>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {status.items.length > 0 && (
        <ul className="alert-list" style={{ marginTop: 14 }}>
          {status.items.map((i) => (
            <li key={i.id}>
              <Icon name="bank" size={12} />
              <span className="grow">
                <strong>{i.institution}</strong>
                {i.accounts.length > 0 && <span className="muted"> · {i.accounts.map((a) => `${a.name}${a.mask ? ` ••${a.mask}` : ''}`).join(', ')}</span>}
                <span className="muted"> · {i.transactions} purchases · {waiting && !i.transactions ? 'fetching…' : ago(i.lastSyncAt)}</span>
                {i.error && <span className="error"> · {i.error}</span>}
              </span>
              <button type="button" className="linkish" disabled={busy} onClick={() => remove(i.id)}>Disconnect</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
