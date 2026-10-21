import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ago, copy, del, get, post, shortDate } from '../../api';
import { Confirm, Dialog, ErrorNote, Loading, useAction, useAsync, useToast, type ConfirmCfg } from '../../ui';
import { ENDPOINTS, MDARK, SCOPES } from '../../reference';
import { fetchCatalog } from '../../life';
import { useAdmin } from './Layout';

type Key = { id: string; name: string; kind: 'session' | 'app' | 'peer'; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; current: boolean };
const KIND = { session: 'Owner session', peer: 'Peer token', app: 'App key' };

export default function Apps() {
  const { tech } = useAdmin();
  const toast = useToast();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();
  const { data, error, reload } = useAsync(() => get<{ items: Key[]; domainScopes: { domain: string; label: string; read: string; write: string }[] }>('/api/v1/keys'), []);
  const [showDomains, setShowDomains] = useState(false);
  const [newKey, setNewKey] = useState<{ name: string; scopes: Record<string, boolean>; secret: string | null } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);

  const { data: catalog } = useAsync(fetchCatalog, []);
  // Starting points. The assistant preset starts with your profile only; pick the categories it may read.
  const presets = (catalog ?? []).length ? [
    { id: 'assistant', label: 'AI assistant', name: 'AI assistant', scopes: ['owner:read'] },
    { id: 'resume', label: 'Résumé builder', name: 'Résumé builder', scopes: ['owner:read', 'employment:read', 'education:read', 'credentials:read'] },
    { id: 'tax', label: 'Tax helper', name: 'Tax helper', scopes: ['owner:read', 'income:read', 'tax_returns:read', 'financial_accounts:read', 'relationships:read'] },
    { id: 'home', label: 'Home automation', name: 'Home Assistant', scopes: ['owner:read', 'contacts:read', 'preferences:read'] },
  ] : [];
  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (p) { setNewKey({ name: p.name, scopes: Object.fromEntries(p.scopes.map((x) => [x, true])), secret: null }); setShowDomains(true); }
  };

  useEffect(() => {
    if (params.get('new') || params.get('preset')) {
      setNewKey({ name: '', scopes: { 'owner:read': true }, secret: null });
      if (!params.get('preset')) setParams({}, { replace: true });
    }
  }, [params, setParams]);
  useEffect(() => {
    if (params.get('preset') && presets.length) { applyPreset(params.get('preset')!); setParams({}, { replace: true }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, presets.length]);

  if (error) return <ErrorNote error={error} />;

  const create = async () => {
    if (!newKey) return;
    const r = await run(() => post<{ secret: string }>('/api/v1/keys', { name: newKey.name, scopes: Object.keys(newKey.scopes).filter((s) => newKey.scopes[s]) }));
    if (r) { setNewKey({ ...newKey, secret: r.secret }); reload(); }
  };
  const revoke = (k: Key) => setConfirm({
    title: `Revoke ${k.name}?`,
    body: k.kind === 'peer' ? 'They will lose access to everything you share. The contact stays in your list.' : 'Anything using this key stops working immediately.',
    cta: 'Revoke',
    onConfirm: async () => { if (await run(() => del(`/api/v1/keys/${k.id}`), 'Key revoked')) reload(); setConfirm(null); },
  });

  return (
    <div data-screen-label="API and keys" style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>Apps and access</h1><p className="text-muted" style={{ margin: 0 }}>Keys let apps and services use your data. Each key can only do what you allow, and you can revoke it any time.</p></div>
        <button className="btn btn-primary" onClick={() => setNewKey({ name: '', scopes: { 'owner:read': true }, secret: null })}>New API key</button>
      </div>
      <h4 style={{ marginTop: 28 }}>Keys</h4>
      {!data ? <Loading /> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Last used</th><th></th></tr></thead>
            <tbody>
              {data.items.map((k) => (
                <tr key={k.id}>
                  <td><div style={{ fontWeight: 600 }}>{k.name}</div><div className="text-muted" style={{ fontSize: 12 }}>{KIND[k.kind]} · created {shortDate(k.createdAt)}</div></td>
                  <td className="mono" style={{ fontSize: 12.5 }}>{k.prefix}</td>
                  <td><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{k.scopes.map((s) => <span key={s} className="tag tag-neutral mono">{s}</span>)}</div></td>
                  <td className="text-muted" style={{ fontSize: 13 }}>{k.current ? 'now' : ago(k.lastUsedAt)}</td>
                  <td style={{ textAlign: 'right' }}>{!k.current && <button className="btn btn-ghost" onClick={() => revoke(k)} style={{ fontSize: 13, color: 'var(--color-accent-700)' }}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tech && <Explorer />}

      {newKey && (
        <Dialog title="New API key" onClose={() => setNewKey(null)} width={520} actions={newKey.secret ? <>
          <button className="btn btn-secondary" onClick={async () => { await copy(newKey.secret!); toast('Key copied'); }}>Copy</button>
          <button className="btn btn-primary" onClick={() => setNewKey(null)}>Done</button>
        </> : <>
          <button className="btn btn-secondary" onClick={() => setNewKey(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !Object.values(newKey.scopes).some(Boolean)} onClick={create}>Create key</button>
        </>}>
          {newKey.secret ? (
            <>
              <div className="dialog-body">Copy this now. For your security it won't be shown again.</div>
              <div className="mono" style={{ fontSize: 13, background: 'var(--color-neutral-900)', color: 'var(--color-accent-300)', borderRadius: 16, padding: '12px 16px', overflowWrap: 'anywhere' }}>{newKey.secret}</div>
              <div className="text-muted" style={{ fontSize: 12 }}>Send it as <span className="mono">Authorization: Bearer …</span></div>
            </>
          ) : (
            <>
              {presets.length > 0 && (
                <div>
                  <div className="text-muted" style={{ fontSize: 12, marginBottom: 6 }}>Start from</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {presets.map((p) => <button key={p.id} onClick={() => applyPreset(p.id)} style={{ border: `1px solid ${newKey.name === p.name ? 'var(--color-accent)' : 'var(--color-divider)'}`, background: newKey.name === p.name ? 'var(--color-accent-100)' : 'transparent', borderRadius: 999, padding: '5px 12px', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>{p.label}</button>)}
                  </div>
                  {newKey.name === 'AI assistant' && <div className="text-muted" style={{ fontSize: 12, marginTop: 8 }}>Reads your profile and the {presets[0].scopes.length - 1} categories you’ve opened to AI. Secret details stay masked. Revoke it any time.</div>}
                </div>
              )}
              <div className="field"><label htmlFor="kn">Name</label><input id="kn" className="input" placeholder="Home Assistant" value={newKey.name} onChange={(e) => setNewKey({ ...newKey, name: e.target.value })} /></div>
              <div className="text-muted" style={{ fontSize: 12 }}>Scopes</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {SCOPES.map((s) => {
                  const on = !!newKey.scopes[s];
                  return <ScopeChip key={s} label={s} on={on} onClick={() => setNewKey({ ...newKey, scopes: { ...newKey.scopes, [s]: !on } })} />;
                })}
              </div>
              <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 13 }} onClick={() => setShowDomains(!showDomains)}>{showDomains ? 'Hide category scopes' : 'Limit to specific categories…'}</button>
              {showDomains && (
                <div style={{ display: 'grid', gap: 6, maxHeight: 260, overflow: 'auto' }}>
                  <div className="text-muted" style={{ fontSize: 12 }}>records:read / records:write cover every category. Or pick just the ones this app needs:</div>
                  {data?.domainScopes.map((d) => (
                    <div key={d.domain} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, flex: 1, minWidth: 140 }}>{d.label}</span>
                      {[d.read, d.write].map((sc) => <ScopeChip key={sc} label={sc.split(':')[1]} on={!!newKey.scopes[sc]} onClick={() => setNewKey({ ...newKey, scopes: { ...newKey.scopes, [sc]: !newKey.scopes[sc] } })} />)}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Dialog>
      )}
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

const ScopeChip = ({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) => (
  <button aria-pressed={on} onClick={onClick} className="mono" style={{ border: `1px solid ${on ? 'var(--color-accent-2-500)' : 'var(--color-divider)'}`, cursor: 'pointer', fontSize: 12, padding: '5px 12px', borderRadius: 999, whiteSpace: 'nowrap', flex: 'none', background: on ? 'var(--color-accent-2-200)' : 'transparent', color: on ? 'var(--color-accent-2-900)' : 'inherit' }}>{label}</button>
);

/** Pick an endpoint → Send → see the real response (GET only; writes go through curl with a key). */
function Explorer() {
  const [sel, setSel] = useState(ENDPOINTS.findIndex((e) => e.m === 'GET' && e.p === '/api/v1/owner'));
  const [res, setRes] = useState<{ status: number; ms: number; body: string } | null>(null);
  const ep = ENDPOINTS[sel];
  const sendable = ep.m === 'GET' && !ep.p.includes('{') && ep.auth !== 'peer';

  const send = async () => {
    const t = performance.now();
    const r = await fetch(ep.p, { credentials: 'same-origin' });
    const text = await r.text();
    let body = text;
    try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* jsonl or text */ }
    setRes({ status: r.status, ms: Math.round(performance.now() - t), body: body.length > 20000 ? body.slice(0, 20000) + '\n…' : body });
  };

  return (
    <>
      <h4 style={{ marginTop: 36 }}>Explorer</h4>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,280px),1fr))', gap: 20, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 2, maxHeight: 520, overflow: 'auto', paddingRight: 4 }}>
          {ENDPOINTS.map((e, i) => (
            <button key={e.m + e.p} onClick={() => { setSel(i); setRes(null); }} style={{ display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left', border: 'none', cursor: 'pointer', font: 'inherit', padding: '8px 12px', borderRadius: 999, background: i === sel ? 'var(--color-accent-100)' : 'transparent', color: 'inherit' }}>
              <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, width: 44, flex: 'none', color: MDARK[e.m] }}>{e.m}</span>
              <span className="mono" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.p}</span>
            </button>
          ))}
        </div>
        <div className="card" style={{ padding: '20px 22px', gap: 12, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="tag tag-accent mono" style={{ fontWeight: 700 }}>{ep.m}</span>
            <span className="mono" style={{ fontSize: 14, flex: 1, overflowWrap: 'anywhere' }}>{ep.p}</span>
            <button className="btn btn-primary" onClick={send} disabled={!sendable}>Send</button>
          </div>
          <div style={{ fontSize: 14 }}>{ep.d}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="tag tag-neutral">Auth: {ep.auth === 'session' ? 'owner (browser session only)' : ep.auth}</span>
            {ep.scope && <span className="tag tag-neutral mono">scope {ep.scope}</span>}
            {ep.auth === 'owner' && <span className="tag tag-neutral mono">Authorization: Bearer ldk_live_…</span>}
          </div>
          {!sendable && <div className="text-muted" style={{ fontSize: 13 }}>The explorer sends simple GET requests from this browser. Try this one with curl and an API key:<pre className="code" style={{ marginTop: 8 }}>{`curl -X ${ep.m} ${location.origin}${ep.p} \\\n  -H 'Authorization: Bearer ldk_live_…'${ep.m !== 'GET' ? " \\\n  -H 'content-type: application/json' -d '{…}'" : ''}`}</pre></div>}
          {res && (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}><span className={`tag ${res.status < 400 ? 'tag-accent-2' : 'tag-accent'}`}>{res.status}</span><span className="text-muted">{res.ms} ms</span></div>
              <pre className="code" style={{ fontSize: 12, maxHeight: 340 }}>{res.body}</pre>
            </>
          )}
        </div>
      </div>
    </>
  );
}
