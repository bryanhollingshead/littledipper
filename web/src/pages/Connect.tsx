import { useSearchParams } from 'react-router-dom';
import { addr, copy, get, longDate } from '../api';
import { Brand, Circle, Loading, useAsync, useToast } from '../ui';

/** Where an invite link lands when opened in a plain browser. */
export default function Connect() {
  const [params] = useSearchParams();
  const token = params.get('invite') || '';
  const toast = useToast();
  const { data } = useAsync(() => get<{ valid: boolean; displayName: string | null; address: string; expiresAt: string | null }>(`/public/v1/invites/${encodeURIComponent(token)}`), [token]);
  if (!data) return <div style={{ padding: 48 }}><Loading /></div>;
  const link = window.location.href;
  return (
    <div style={{ minHeight: '100%', position: 'relative', overflow: 'hidden', padding: '48px clamp(20px,7vw,96px) 64px' }}>
      <Circle style={{ right: -160, top: -120, width: 480, height: 480, background: 'var(--color-accent-2-200)', opacity: 0.7 }} />
      <div style={{ position: 'relative', maxWidth: 600 }}>
        <div style={{ marginBottom: 40 }}><Brand name={data.displayName || 'Little Dipper'} /></div>
        {data.valid ? (
          <>
            <span className="tag tag-accent-2">Invite</span>
            <h1 style={{ marginTop: 14, textWrap: 'pretty' }}>{data.displayName} invited you to connect.</h1>
            <p style={{ fontSize: 17 }}>Open your own Little Dipper, choose <strong>Add contact → On Little Dipper</strong>, and paste this link. {data.displayName?.split(' ')[0]} will see your request and choose what to share.</p>
            <div className="mono" style={{ fontSize: 12, background: 'var(--color-neutral-100)', borderRadius: 16, padding: '10px 14px', overflowWrap: 'anywhere', margin: '18px 0' }}>{link}</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn btn-primary" onClick={async () => { await copy(link); toast('Invite link copied'); }}>Copy link</button>
              <span className="text-muted" style={{ fontSize: 13 }}>Works once · expires {data.expiresAt ? longDate(data.expiresAt) : ''}</span>
            </div>
            <p className="text-muted" style={{ fontSize: 14, marginTop: 32 }}>Don't have Little Dipper yet? It's free and open source, and you run your own.</p>
          </>
        ) : (
          <>
            <span className="tag tag-accent">Invite link</span>
            <h1 style={{ marginTop: 14 }}>This invite has expired or was already used.</h1>
            <p style={{ fontSize: 17 }}>Ask {data.displayName || 'the owner'} for a new one, or visit <a href="/">{addr(data.address)}</a>.</p>
          </>
        )}
      </div>
    </div>
  );
}
