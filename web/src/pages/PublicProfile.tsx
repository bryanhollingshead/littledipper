import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { addr, copy, get } from '../api';
import { Circle, Dialog, ErrorNote, Loading, Striped, useAsync, useToast } from '../ui';

type Profile = { displayName: string; headline: string; fields: { key: string; label: string; value: string }[]; connectRequests: 'off' | 'fof' | 'anyone'; address: string; ownerFirstName: string };

export default function PublicProfile() {
  const toast = useToast();
  const { data: p, error } = useAsync(() => get<Profile>('/public/v1/profile'), []);
  const [isOwner, setIsOwner] = useState(false);
  const [connect, setConnect] = useState(false);

  useEffect(() => {
    get('/api/v1/owner').then(() => setIsOwner(true)).catch(() => {});
  }, []);
  useEffect(() => {
    if (p) document.title = p.displayName;
  }, [p]);

  if (error) return <div style={{ padding: 48 }}><ErrorNote error={error} /></div>;
  if (!p) return <div style={{ padding: 48 }}><Loading /></div>;
  const a = addr(p.address);

  return (
    <div data-screen-label="Public profile" style={{ minHeight: '100%', position: 'relative', overflow: 'hidden' }}>
      {isOwner && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px clamp(20px,7vw,96px)', background: 'var(--color-accent-2-100)', color: 'var(--color-accent-2-800)', fontSize: 13, flexWrap: 'wrap' }}>
          <span>Visitor view. Nothing here requires a login.</span>
          <Link className="btn btn-ghost" to="/admin/public" style={{ color: 'var(--color-accent-2-800)', fontFamily: 'var(--font-body)', fontWeight: 600 }}>Back to visibility editor</Link>
        </div>
      )}
      <Circle style={{ right: -160, top: 40, width: 560, height: 560, background: 'var(--color-accent-200)', opacity: 0.55 }} />
      <div style={{ position: 'relative', padding: '36px clamp(20px,7vw,96px) 80px', maxWidth: 820 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 56, gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--color-accent)' }} /><span className="mono" style={{ fontSize: 13 }}>{a}</span></div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={() => toast('API documentation is coming soon')}>API docs</button>
            {p.connectRequests !== 'off' && <button className="btn btn-primary" onClick={() => setConnect(true)}>Connect with me</button>}
          </div>
        </div>
        <div style={{ marginBottom: 24 }}><Striped size={132} label="portrait" /></div>
        <h1 style={{ fontSize: 56, marginBottom: 6 }}>{p.displayName}</h1>
        {p.headline && <p style={{ fontSize: 19, maxWidth: 540, textWrap: 'pretty' }}>{p.headline}</p>}
        <div style={{ display: 'grid', marginTop: 40, maxWidth: 560 }}>
          {p.fields.map((f) => (
            <div key={f.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 20, padding: '14px 0', borderBottom: '1px solid var(--color-divider)', flexWrap: 'wrap' }}>
              <span className="text-muted">{f.label}</span><span style={{ textAlign: 'right' }}>{f.value}</span>
            </div>
          ))}
        </div>
        {p.fields.length === 0 && <p className="text-muted" style={{ marginTop: 32 }}>This owner hasn't made any details public.</p>}
        <p className="text-muted" style={{ fontSize: 12, marginTop: 56 }}>Your data, not your definition.{!isOwner && <> · <Link to="/login" style={{ color: 'inherit' }}>Owner sign in</Link></>}</p>
      </div>

      {connect && (
        <Dialog title={`Connect with ${p.displayName}`} onClose={() => setConnect(false)} actions={<>
          <button className="btn btn-secondary" onClick={() => setConnect(false)}>Close</button>
          <button className="btn btn-primary" onClick={async () => { await copy(a); setConnect(false); toast('Address copied'); }}>Copy address</button>
        </>}>
          <div className="dialog-body">Open your own Little Dipper, choose Add contact → On Little Dipper, and enter this address. {p.ownerFirstName} will see your request and choose what to share.</div>
          <div className="mono" style={{ fontSize: 15, background: 'var(--color-neutral-100)', borderRadius: 999, padding: '10px 18px', overflowWrap: 'anywhere' }}>{a}</div>
          <div className="text-muted" style={{ fontSize: 13 }}>Don't have Little Dipper yet? It's free and open source.</div>
        </Dialog>
      )}
    </div>
  );
}
