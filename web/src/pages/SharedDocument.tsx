import { useParams } from 'react-router-dom';
import { get, longDate, type FileRef } from '../api';
import { Loading, useAsync } from '../ui';
import { isImage } from '../docs';

type Shared = { title: string; kind: string; date: string | null; pages: FileRef[]; expiresAt: string; sharedBy: string | null };

/** What someone without a Little Dipper sees when the owner shares a document with them. */
export default function SharedDocument() {
  const { token = '' } = useParams();
  const { data, error } = useAsync(() => get<Shared>(`/public/v1/shared/${encodeURIComponent(token)}`), [token]);
  const url = (p: FileRef) => `/public/v1/shared/${encodeURIComponent(token)}/files/${p.id}`;
  return (
    <div style={{ minHeight: '100%', background: 'var(--color-bg)', padding: '32px 16px 64px' }}>
      <div style={{ maxWidth: 860, margin: '0 auto' }}>
        {error ? (
          <div className="card" style={{ padding: '30px 28px', gap: 8 }}>
            <div className="card-title" style={{ fontSize: 22 }}>This link isn’t available</div>
            <div className="text-muted" style={{ fontSize: 14 }}>It may have expired or been turned off. Ask the person who sent it for a new one.</div>
          </div>
        ) : !data ? <Loading /> : (
          <>
            <div className="card-kicker">{data.sharedBy ? `Shared by ${data.sharedBy}` : 'Shared document'}</div>
            <h1 style={{ margin: '4px 0' }}>{data.title}</h1>
            <p className="text-muted" style={{ fontSize: 13, margin: '0 0 22px' }}>This link stops working {longDate(data.expiresAt)}.</p>
            <div style={{ display: 'grid', gap: 18 }}>
              {data.pages.map((p, i) => (
                <figure key={p.id} style={{ margin: 0 }}>
                  {isImage(p) ? <img src={url(p)} alt={`Page ${i + 1}`} style={{ width: '100%', borderRadius: 16, background: 'var(--color-neutral-200)' }} />
                    : p.type === 'application/pdf' ? <iframe title={`Page ${i + 1}`} src={url(p)} style={{ width: '100%', height: '80vh', border: 0, borderRadius: 16, background: '#fff' }} />
                      : <div className="card" style={{ padding: 20 }}>{p.name}</div>}
                  <figcaption className="text-muted" style={{ fontSize: 12, marginTop: 6 }}>
                    {data.pages.length > 1 ? `Page ${i + 1} · ` : ''}<a href={`${url(p)}?download=1`}>Download</a>
                  </figcaption>
                </figure>
              ))}
            </div>
            <p className="text-muted" style={{ fontSize: 12, marginTop: 32 }}>Kept on {data.sharedBy ? `${data.sharedBy}’s` : 'a'} own Little Dipper, a personal data store.</p>
          </>
        )}
      </div>
    </div>
  );
}
