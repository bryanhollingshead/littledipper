import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ago, copy, del, get, patch, post, shortDate } from '../../api';
import { Confirm, Dialog, ErrorNote, Loading, Toggle, useAction, useAsync, useToast, type ConfirmCfg } from '../../ui';
import { ENDPOINTS, MDARK, SCOPES } from '../../reference';
import { fetchCatalog, type Domain } from '../../life';
import { useAdmin } from './Layout';

type Mode = 'answer' | 'suggest' | 'make';
type Assistant = { mode: Mode; secretFields: string[] };
type Key = { id: string; name: string; kind: 'session' | 'app' | 'peer'; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; current: boolean; assistant: Assistant | null };
const MODES: [Mode, string, string][] = [
  ['answer', 'Answer questions', 'Reads what you allow. Changes nothing.'],
  ['suggest', 'Suggest changes', 'Its changes wait in Review until you approve them.'],
  ['make', 'Make changes', 'Its changes are saved straight away. You can see and undo them.'],
];
const modeLabel = (m: Mode) => MODES.find(([k]) => k === m)![1];
const KIND = { session: 'Owner session', peer: 'Peer token', app: 'App key' };

export default function Apps() {
  const { tech, node } = useAdmin();
  const mcpAddress = `${node.address}/api/mcp`;
  const toast = useToast();
  const { run, busy } = useAction();
  const [params, setParams] = useSearchParams();
  const { data, error, reload } = useAsync(() => get<{ items: Key[]; domainScopes: { domain: string; label: string; read: string; write: string }[] }>('/api/keys'), []);
  const [showDomains, setShowDomains] = useState(false);
  const [newKey, setNewKey] = useState<{ name: string; scopes: Record<string, boolean>; secret: string | null; assistant?: Assistant | null } | null>(null);
  const [editing, setEditing] = useState<Key | null>(null);
  const [activity, setActivity] = useState<Key | null>(null);
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
    if (p) { setNewKey({ name: p.name, scopes: Object.fromEntries(p.scopes.map((x) => [x, true])), secret: null, assistant: p.id === 'assistant' ? { mode: 'suggest', secretFields: [] } : null }); setShowDomains(true); }
  };

  useEffect(() => {
    const id = params.get('assistant');
    const k = id && data?.items.find((x) => x.id === id);
    if (k) { setActivity(k); setParams({}, { replace: true }); }
  }, [params, data, setParams]);
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
    const r = await run(() => post<{ secret: string }>('/api/keys', { name: newKey.name, scopes: Object.keys(newKey.scopes).filter((s) => newKey.scopes[s]), ...(newKey.assistant ? { assistant: newKey.assistant } : {}) }));
    if (r) { setNewKey({ ...newKey, secret: r.secret }); reload(); }
  };
  const revoke = (k: Key) => setConfirm({
    title: `Revoke ${k.name}?`,
    body: k.kind === 'peer' ? 'They will lose access to everything you share. The contact stays in your list.'
      : k.assistant ? 'It stops working immediately. Anything it suggested stays in Review, and you can undo what it changed next.'
        : 'Anything using this key stops working immediately.',
    cta: 'Revoke',
    onConfirm: async () => {
      if (await run(() => del(`/api/keys/${k.id}`), 'Key revoked')) { reload(); if (k.assistant) setActivity(k); }
      setConfirm(null);
    },
  });

  return (
    <div data-screen-label="API and keys" style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>Apps and access</h1><p className="text-muted" style={{ margin: 0 }}>Keys let apps and services use your data. Each key can only do what you allow, and you can revoke it any time.</p></div>
        <button className="btn btn-primary" onClick={() => setNewKey({ name: '', scopes: { 'owner:read': true }, secret: null })}>New API key</button>
      </div>
      <ConnectAssistant />
      <h4 style={{ marginTop: 28 }}>Keys</h4>
      {!data ? <Loading /> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Last used</th><th></th></tr></thead>
            <tbody>
              {data.items.map((k) => (
                <tr key={k.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{k.name}</div>
                    <div className="text-muted" style={{ fontSize: 12 }}>{k.assistant ? 'AI assistant' : KIND[k.kind]} · created {shortDate(k.createdAt)}</div>
                    {k.assistant && (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, flexWrap: 'wrap' }}>
                        <span className="tag tag-accent-2" style={{ fontSize: 11 }}>{modeLabel(k.assistant.mode)}</span>
                        {k.assistant.secretFields.length > 0 && <span className="tag tag-accent" style={{ fontSize: 11 }}>{k.assistant.secretFields.length} secret {k.assistant.secretFields.length === 1 ? 'field' : 'fields'}</span>}
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setEditing(k)}>Change</button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '2px 8px' }} onClick={() => setActivity(k)}>What it did</button>
                      </div>
                    )}
                  </td>
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
              <div className="card" style={{ padding: '14px 16px', gap: 6, marginTop: 6 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Connecting an AI assistant?</div>
                <div style={{ fontSize: 13 }}>Give it this address along with the key:</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{mcpAddress}</span>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => { await copy(mcpAddress); toast('Address copied'); }}>Copy</button>
                </div>
                <div className="text-muted" style={{ fontSize: 12 }}>Enter the key on the assistant’s own connection page, never in a chat: anything in a chat can end up in its history.</div>
              </div>
            </>
          ) : (
            <>
              {presets.length > 0 && (
                <div>
                  <div className="text-muted" style={{ fontSize: 12, marginBottom: 6 }}>Start from</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {presets.map((p) => <button key={p.id} onClick={() => applyPreset(p.id)} style={{ border: `1px solid ${newKey.name === p.name ? 'var(--color-accent)' : 'var(--color-divider)'}`, background: newKey.name === p.name ? 'var(--color-accent-100)' : 'transparent', borderRadius: 999, padding: '5px 12px', font: 'inherit', fontSize: 13, cursor: 'pointer' }}>{p.label}</button>)}
                  </div>
                  {newKey.name === 'AI assistant' && <div className="text-muted" style={{ fontSize: 12, marginTop: 8 }}>Starts with your profile only: pick the categories it may read below. Secret details stay hidden unless you allow them. Revoke it any time.</div>}
                </div>
              )}
              <div className="field"><label htmlFor="kn">Name</label><input id="kn" className="input" placeholder="Home Assistant" value={newKey.name} onChange={(e) => setNewKey({ ...newKey, name: e.target.value })} /></div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <Toggle on={!!newKey.assistant} onChange={() => setNewKey({ ...newKey, assistant: newKey.assistant ? null : { mode: 'suggest', secretFields: [] } })} label="This key is for an AI assistant" />
                <span style={{ fontSize: 14 }}>This key is for an AI assistant</span>
              </div>
              {newKey.assistant && (
                <AssistantChoices
                  value={newKey.assistant} onChange={(assistant) => setNewKey({ ...newKey, assistant })}
                  domains={(catalog ?? []).filter((d) => newKey.scopes['records:read'] || newKey.scopes[`${d.id}:read`])}
                />
              )}
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
      {editing?.assistant && <EditAssistant k={editing} domains={(catalog ?? []).filter((d) => editing.scopes.includes('records:read') || editing.scopes.includes(`${d.id}:read`))} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />}
      {activity && <AssistantActivity k={activity} onClose={() => setActivity(null)} />}
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

/** How to connect each assistant. "Tested" only once someone has run the six phase-1 jobs with it. */
const ASSISTANTS: { name: string; status: 'Tested' | 'Should work'; how: string }[] = [
  { name: 'Muse', status: 'Should work', how: 'Ask Muse to connect to your Little Dipper and give it the address below. Muse sends you a link: open it, and your Little Dipper asks what Muse may do.' },
  { name: 'Claude', status: 'Should work', how: 'In Claude’s settings, add a custom connector and paste the address below. Claude opens your Little Dipper so you can approve it.' },
  { name: 'ChatGPT', status: 'Should work', how: 'In ChatGPT’s settings, add a connector (it may need developer mode turned on) and paste the address below. ChatGPT opens your Little Dipper so you can approve it.' },
];

function ConnectAssistant() {
  const toast = useToast();
  const { node } = useAdmin();
  const [open, setOpen] = useState<string | null>(null);
  // The node's own address, not the browser's: assistants must reach the server, and it's the one OAuth uses.
  const mcp = `${node.address}/api/mcp`;
  return (
    <div className="card" style={{ marginTop: 24, padding: '18px 22px', gap: 12 }}>
      <div>
        <div style={{ fontWeight: 600 }}>Connect an AI assistant</div>
        <div className="text-muted" style={{ fontSize: 13.5 }}>It asks you here, on your Little Dipper, what it may see and do. You can watch what it does, undo it, and disconnect it any time.</div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {ASSISTANTS.map((x) => (
          <button key={x.name} className={`btn ${open === x.name ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: 13 }} onClick={() => setOpen(open === x.name ? null : x.name)}>
            {x.name} <span style={{ opacity: 0.7, fontWeight: 400, marginLeft: 6 }}>{x.status}</span>
          </button>
        ))}
        <button className={`btn ${open === 'other' ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: 13 }} onClick={() => setOpen(open === 'other' ? null : 'other')}>Another assistant</button>
      </div>
      {open && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ fontSize: 14 }}>{ASSISTANTS.find((x) => x.name === open)?.how ?? 'Any assistant that supports MCP connectors can connect with this address. If it can’t open your Little Dipper to ask you, create a key below for it instead.'}</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 13, background: 'var(--color-neutral-100)', padding: '6px 12px', borderRadius: 999, overflowWrap: 'anywhere' }}>{mcp}</span>
            <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => { await copy(mcp); toast('Address copied'); }}>Copy</button>
          </div>
          {open !== 'other' && ASSISTANTS.find((x) => x.name === open)?.status === 'Should work' && (
            <div className="text-muted" style={{ fontSize: 12 }}>“Should work” means it follows the standard but nobody has tried every step with it yet. Tell us how it goes.</div>
          )}
        </div>
      )}
    </div>
  );
}

type Session = { start: string; end: string; changes: number; records: { recordId: string; domain: string; domainLabel: string; title: string; added: boolean; changes: number }[] };
type UndoResult = { recordId: string; title: string; outcome: 'reverted' | 'removed' | 'skipped' | 'nothing'; reverted: string[]; skipped: string[]; reason?: string };

/** An assistant's changes, grouped into sessions, each one undoable. */
function AssistantActivity({ k, onClose }: { k: Key; onClose: () => void }) {
  const { run, busy } = useAction();
  const { data, reload } = useAsync(() => get<{ items: Session[] }>(`/api/keys/${k.id}/sessions`), [k.id]);
  const [results, setResults] = useState<UndoResult[] | null>(null);
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const undo = async (s: Session) => {
    const r = await run(() => post<{ results: UndoResult[] }>(`/api/keys/${k.id}/sessions/undo`, { start: s.start }));
    if (r) { setResults(r.results); reload(); }
  };
  return (
    <Dialog title={`What ${k.name} did`} onClose={onClose} width={600} actions={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      {results && (
        <div className="card" style={{ padding: '14px 16px', gap: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Undone</div>
          {results.map((r) => (
            <div key={r.recordId} style={{ fontSize: 13 }}>
              <strong>{r.title}</strong>: {r.outcome === 'removed' ? 'removed (you can bring it back for 30 days)' : r.outcome === 'reverted' ? `put back ${r.reverted.join(', ')}` : r.reason ?? 'nothing to undo'}
              {r.outcome === 'reverted' && r.skipped.length > 0 && <span className="text-muted">. Kept your later change to {r.skipped.join(', ')}.</span>}
            </div>
          ))}
        </div>
      )}
      {!data ? <Loading /> : !data.items.length ? <div className="text-muted" style={{ fontSize: 14 }}>It hasn’t changed anything yet.</div> : (
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="text-muted" style={{ fontSize: 12.5 }}>Undo puts back only what it changed. Anything you’ve changed since stays as you left it.</div>
          {data.items.map((s) => (
            <div key={s.start} style={{ display: 'grid', gap: 6, padding: '12px 14px', borderRadius: 14, background: 'var(--color-neutral-100)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ fontSize: 13 }}><strong>{when(s.start)}</strong> · {s.records.length} {s.records.length === 1 ? 'entry' : 'entries'}</div>
                <button className="btn btn-secondary" style={{ fontSize: 12 }} disabled={busy} onClick={() => undo(s)}>Undo this session</button>
              </div>
              {s.records.map((r) => (
                <div key={r.recordId} style={{ fontSize: 13 }}>
                  {r.added ? 'Added' : 'Changed'} {r.title} <span className="text-muted">({r.domainLabel})</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

/** What an assistant may change, and which secret details it may read. */
function AssistantChoices({ value, onChange, domains }: { value: Assistant; onChange: (a: Assistant) => void; domains: Domain[] }) {
  const secrets = domains.flatMap((d) => d.parts.filter((p) => p.sensitivity === 'secret' && !p.deprecated).map((p) => ({ id: `${d.id}.${p.key}`, label: `${d.label}: ${p.label}` })));
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gap: 6 }}>
        {MODES.map(([m, label, text]) => (
          <label key={m} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', padding: '8px 12px', borderRadius: 14, border: `1px solid ${value.mode === m ? 'var(--color-accent)' : 'var(--color-divider)'}`, background: value.mode === m ? 'var(--color-accent-100)' : 'transparent' }}>
            <input type="radio" name="mode" checked={value.mode === m} onChange={() => onChange({ ...value, mode: m })} style={{ marginTop: 3 }} />
            <span><span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span><br /><span className="text-muted" style={{ fontSize: 12.5 }}>{text}</span></span>
          </label>
        ))}
      </div>
      <div className="text-muted" style={{ fontSize: 12 }}>New secret values it suggests always wait in Review. Pick the secret details it may <em>read</em>:</div>
      {secrets.length ? (
        <div style={{ display: 'grid', gap: 4, maxHeight: 160, overflow: 'auto' }}>
          {secrets.map((f) => (
            <label key={f.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={value.secretFields.includes(f.id)} onChange={(e) => onChange({ ...value, secretFields: e.target.checked ? [...value.secretFields, f.id] : value.secretFields.filter((x) => x !== f.id) })} />
              {f.label}
            </label>
          ))}
        </div>
      ) : <div className="text-muted" style={{ fontSize: 12.5 }}>None of the categories it can read have secret details.</div>}
    </div>
  );
}

function EditAssistant({ k, domains, onClose, onSaved }: { k: Key; domains: Domain[]; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [value, setValue] = useState<Assistant>(k.assistant!);
  const save = async () => { if (await run(() => patch(`/api/keys/${k.id}`, { assistant: value }), 'Saved')) onSaved(); };
  return (
    <Dialog title={`What ${k.name} may do`} onClose={onClose} width={520} actions={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={save}>Save</button>
    </>}>
      <AssistantChoices value={value} onChange={setValue} domains={domains} />
    </Dialog>
  );
}

const ScopeChip = ({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) => (
  <button aria-pressed={on} onClick={onClick} className="mono" style={{ border: `1px solid ${on ? 'var(--color-accent-2-500)' : 'var(--color-divider)'}`, cursor: 'pointer', fontSize: 12, padding: '5px 12px', borderRadius: 999, whiteSpace: 'nowrap', flex: 'none', background: on ? 'var(--color-accent-2-200)' : 'transparent', color: on ? 'var(--color-accent-2-900)' : 'inherit' }}>{label}</button>
);

/** Pick an endpoint → Send → see the real response (GET only; writes go through curl with a key). */
function Explorer() {
  const [sel, setSel] = useState(ENDPOINTS.findIndex((e) => e.m === 'GET' && e.p === '/api/owner'));
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
