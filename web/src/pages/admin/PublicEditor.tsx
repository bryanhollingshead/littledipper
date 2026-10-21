import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { addr, get, put, SENS, type Field } from '../../api';
import { ErrorNote, Loading, Striped, Toggle, useAction, useAsync } from '../../ui';
import { useAdmin } from './Layout';

type PP = { displayName: string; headline: string; fieldKeys: string[]; connectRequests: 'off' | 'fof' | 'anyone' };

const CONNECT: [PP['connectRequests'], string, string][] = [
  ['off', 'Nobody', 'Hide the button. People can still connect with an invite link from you.'],
  ['fof', 'People my contacts know', 'Only someone already connected to one of your contacts.'],
  ['anyone', 'Anyone on Little Dipper', 'Requests from strangers wait quietly in Contacts, with no notification.'],
];

export default function PublicEditor() {
  const { node } = useAdmin();
  const { run } = useAction();
  const { data: pp, error, setData } = useAsync(() => get<PP>('/api/v1/public-profile'), []);
  const { data: fields } = useAsync(() => get<{ items: Field[] }>('/api/v1/owner/fields'), []);
  const [header, setHeader] = useState<{ displayName: string; headline: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (pp && !header) setHeader({ displayName: pp.displayName, headline: pp.headline });
  }, [pp, header]);

  if (error) return <ErrorNote error={error} />;
  if (!pp || !fields || !header) return <Loading />;

  const save = async (body: Partial<PP>) => {
    const r = await run(() => put<PP>('/api/v1/public-profile', body));
    if (r) setData(r);
  };
  // Header edits save as you type (debounced).
  const editHeader = (k: 'displayName' | 'headline', v: string) => {
    setHeader({ ...header, [k]: v });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save({ [k]: v }), 500);
  };
  const toggle = (key: string) => save({ fieldKeys: pp.fieldKeys.includes(key) ? pp.fieldKeys.filter((k) => k !== key) : [...pp.fieldKeys, key] });

  const visible = pp.fieldKeys.map((k) => fields.items.find((f) => f.key === k)).filter((f): f is Field => !!f && f.sensitivity !== 'secret' && f.hasValue);

  return (
    <div data-screen-label="Public profile editor" style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>Public profile</h1><p className="text-muted" style={{ margin: 0 }}>What anyone visiting <span className="mono">{addr(node.address)}</span> can see.</p></div>
        <Link className="btn btn-primary" to="/">View as visitor</Link>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,420px),1fr))', gap: 24, marginTop: 26, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 20 }}>
          <div className="card" style={{ padding: '20px 24px', gap: 14 }}>
            <div className="card-kicker">Header</div>
            <div className="field"><label htmlFor="dn">Display name</label><input id="dn" className="input" value={header.displayName} onChange={(e) => editHeader('displayName', e.target.value)} /></div>
            <div className="field"><label htmlFor="hl">Headline</label><input id="hl" className="input" value={header.headline} placeholder="What you'd like people to know first" onChange={(e) => editHeader('headline', e.target.value)} /></div>
          </div>
          <div className="card" style={{ padding: '20px 24px', gap: 4 }}>
            <div className="card-kicker">Fields</div>
            {fields.items.map((f) => {
              const locked = f.sensitivity === 'secret';
              const on = pp.fieldKeys.includes(f.key);
              return (
                <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: '1px solid var(--color-divider)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14 }}>{f.label}</div><div className="text-muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{locked ? 'Secret fields are never public' : !f.hasValue ? 'Not added yet' : on ? f.value : 'Hidden'}</div></div>
                  <span className={`tag ${SENS[f.sensitivity][1]}`}>{SENS[f.sensitivity][0]}</span>
                  {locked
                    ? <span className="tag tag-neutral" style={{ width: 64, justifyContent: 'center' }}>Never</span>
                    : <Toggle on={on} label={`Show ${f.label} publicly`} onChange={() => toggle(f.key)} style={{ marginLeft: 12, marginRight: 12 }} />}
                </div>
              );
            })}
          </div>
          <div className="card" style={{ padding: '20px 24px', gap: 10 }}>
            <div className="card-kicker">Connection requests</div>
            <div className="text-muted" style={{ fontSize: 13 }}>Who can ask to connect from your public profile. Requests never include anything until you approve and choose what to share.</div>
            <div role="radiogroup" aria-label="Connection requests" style={{ display: 'grid', gap: 4 }}>
              {CONNECT.map(([k, label, hint]) => (
                <button key={k} role="radio" aria-checked={pp.connectRequests === k} className="bare" onClick={() => save({ connectRequests: k })} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '4px 0' }}>
                  <span style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid var(--color-accent)', background: pp.connectRequests === k ? 'var(--color-accent)' : 'transparent', boxShadow: pp.connectRequests === k ? 'inset 0 0 0 2px var(--color-neutral-100)' : undefined, flex: 'none', marginTop: 3 }} />
                  <span><span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{label}</span><span className="text-muted" style={{ fontSize: 12 }}>{hint}</span></span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ position: 'sticky', top: 0 }}>
          <div className="text-muted" style={{ fontSize: 12, marginBottom: 8 }}>Live preview</div>
          <div style={{ borderRadius: 32, background: 'var(--color-neutral-100)', boxShadow: 'var(--shadow-md)', padding: 28, position: 'relative', overflow: 'hidden' }}>
            <div aria-hidden style={{ position: 'absolute', right: -80, top: -60, width: 220, height: 220, borderRadius: '50%', background: 'var(--color-accent-200)', opacity: 0.6 }} />
            <div style={{ position: 'relative' }}>
              <div style={{ marginBottom: 14 }}><Striped size={64} step={6} /></div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 28, lineHeight: 1.1 }}>{header.displayName}</div>
              <div style={{ fontSize: 14, margin: '6px 0 10px' }}>{header.headline}</div>
              <div style={{ marginTop: 14 }}>
                {visible.map((f) => <div key={f.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--color-divider)', fontSize: 13, flexWrap: 'wrap' }}><span className="text-muted">{f.label}</span><span>{f.value}</span></div>)}
                {visible.length === 0 && <div className="text-muted" style={{ fontSize: 13 }}>No details are public.</div>}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 16, flexWrap: 'wrap' }}>
                <span className="btn btn-secondary" style={{ fontSize: 12, padding: '5px 12px' }}>API docs</span>
                {pp.connectRequests !== 'off' && <span className="btn btn-primary" style={{ fontSize: 12, padding: '5px 12px' }}>Connect with me</span>}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
