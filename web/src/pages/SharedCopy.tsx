import { useParams } from 'react-router-dom';
import { get, longDate } from '../api';
import { Loading, useAsync } from '../ui';
import { fmtRange } from '../life';

type Entry = { id: string; title: string; fields: { key: string; label: string; value: string; rows?: string[] }[]; validFrom: string | null; validTo: string | null; current: boolean };
type Shared = { title: string; note: string; sharedBy: string; createdAt: string; expiresAt: string | null; categories: { domain: string; label: string; records: Entry[] }[] };

/** What someone without a Little Dipper sees when the owner sends them a copy of some entries. */
export default function SharedCopy() {
  const { token = '' } = useParams();
  const { data, error } = useAsync(() => get<Shared>(`/public/v1/copies/${encodeURIComponent(token)}`), [token]);
  const dl = (f: string) => `/public/v1/copies/${encodeURIComponent(token)}/download?format=${f}`;
  return (
    <div style={{ minHeight: '100%', background: 'var(--color-bg)', padding: '32px 16px 64px' }}>
      <div style={{ maxWidth: 760, margin: '0 auto' }}>
        {error ? (
          <div className="card" style={{ padding: '30px 28px', gap: 8 }}>
            <div className="card-title" style={{ fontSize: 22 }}>This link isn’t available</div>
            <div className="text-muted" style={{ fontSize: 14 }}>It may have expired or been turned off. Ask the person who sent it for a new one.</div>
          </div>
        ) : !data ? <Loading /> : (
          <>
            <div className="card-kicker">{data.sharedBy ? `Shared by ${data.sharedBy}` : 'Shared with you'}</div>
            <h1 style={{ margin: '4px 0' }}>{data.title}</h1>
            <p className="text-muted" style={{ fontSize: 13, margin: '0 0 14px' }}>
              As of {longDate(data.createdAt)}. {data.expiresAt ? `This link stops working ${longDate(data.expiresAt)}.` : ''}
            </p>
            {data.note && <p style={{ fontSize: 15, margin: '0 0 18px', whiteSpace: 'pre-wrap' }}>{data.note}</p>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 24 }}>
              <span style={{ fontSize: 13 }}>Save a copy:</span>
              <a className="btn btn-secondary" style={{ fontSize: 13 }} href={dl('pdf')}>PDF</a>
              <a className="btn btn-secondary" style={{ fontSize: 13 }} href={dl('json')}>JSON</a>
              <a className="btn btn-secondary" style={{ fontSize: 13 }} href={dl('txt')}>Text</a>
            </div>
            <div style={{ display: 'grid', gap: 26 }}>
              {data.categories.map((c) => (
                <section key={c.domain} style={{ display: 'grid', gap: 12 }}>
                  {data.categories.length > 1 && <h3 style={{ margin: 0 }}>{c.label}</h3>}
                  {c.records.map((r) => (
                    <div key={r.id} className="card" style={{ padding: '18px 22px', gap: 4 }}>
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: 19, lineHeight: 1.25 }}>{r.title}</div>
                      {(r.validFrom || r.validTo) && <div className="text-muted" style={{ fontSize: 13 }}>{fmtRange(r.validFrom, r.validTo)}</div>}
                      <div style={{ marginTop: 6 }}>
                        {r.fields.map((f) => (
                          <div key={f.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '8px 0', borderBottom: '1px solid var(--color-divider)', flexWrap: 'wrap' }}>
                            <span className="text-muted" style={{ fontSize: 13 }}>{f.label}</span>
                            {f.rows ? (
                              <span style={{ fontSize: 14, display: 'grid', gap: 2, textAlign: 'right' }}>{f.rows.map((row, i) => <span key={i}>{row}</span>)}</span>
                            ) : <span style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{f.value}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </section>
              ))}
            </div>
            <p className="text-muted" style={{ fontSize: 12, marginTop: 32 }}>Kept on {data.sharedBy ? `${data.sharedBy}’s` : 'a'} own Little Dipper, a personal data store. This is a copy: later changes don’t show up here.</p>
          </>
        )}
      </div>
    </div>
  );
}
