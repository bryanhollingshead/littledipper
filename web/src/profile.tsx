/** The public profile body, drawn from what /public/v1/profile returns. The editor preview uses the same component. */
import { useState } from 'react';
import { initials, type FileRef } from './api';
import { duration, fmtRange } from './life';
import { Lightbox, Thumb } from './docs';

type Field = { key: string; label: string; value: string };
type Item = { id: string; title: string; fields: (Field & { type: string })[]; validFrom: string | null; validTo: string | null; current: boolean };
type Page = FileRef & { url: string };
export type ViewSection =
  | { type: 'details'; fields: Field[] }
  | { type: 'about'; text: string }
  | { type: 'domain'; domain: string; title: string; dated: boolean; items: Item[] }
  | { type: 'resume'; title: string; document: { title: string; updatedAt: string; pages: Page[] } };
export type ProfileViewData = { displayName: string; headline: string; avatarUrl: string | null; sections: ViewSection[] };

export function Portrait({ name, url, size }: { name: string; url: string | null; size: number }) {
  return url
    ? <img src={url} alt={name} style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', display: 'block', background: 'var(--color-neutral-200)' }} />
    : <span aria-hidden style={{ width: size, height: size, borderRadius: '50%', background: 'var(--color-accent-200)', color: 'var(--color-accent-800)', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-heading)', fontSize: size * 0.36 }}>{initials(name)}</span>;
}

/** compact: the smaller version in the editor's preview. */
export function ProfileView({ p, compact }: { p: ProfileViewData; compact?: boolean }) {
  const [viewing, setViewing] = useState<Page[] | null>(null);
  const h = compact ? { name: 28, head: 14, sec: 17, gap: 26, photo: 72 } : { name: 56, head: 19, sec: 24, gap: 48, photo: 132 };
  return (
    <div>
      <div style={{ marginBottom: compact ? 14 : 24 }}><Portrait name={p.displayName} url={p.avatarUrl} size={h.photo} /></div>
      <h1 style={{ fontSize: h.name, margin: '0 0 6px', lineHeight: 1.05 }}>{p.displayName}</h1>
      {p.headline && <p style={{ fontSize: h.head, maxWidth: 560, margin: 0, textWrap: 'pretty' }}>{p.headline}</p>}

      {p.sections.map((s, i) => (
        <section key={i} style={{ marginTop: h.gap, maxWidth: 640 }}>
          {s.type === 'about' && <p style={{ fontSize: compact ? 13 : 17, lineHeight: 1.6, whiteSpace: 'pre-wrap', margin: 0, textWrap: 'pretty' }}>{s.text}</p>}

          {s.type === 'details' && s.fields.length > 0 && (
            <div style={{ display: 'grid' }}>
              {s.fields.map((f) => (
                <div key={f.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 20, padding: compact ? '8px 0' : '14px 0', borderBottom: '1px solid var(--color-divider)', flexWrap: 'wrap', fontSize: compact ? 13 : undefined }}>
                  <span className="text-muted">{f.label}</span><span style={{ textAlign: 'right' }}>{f.value}</span>
                </div>
              ))}
            </div>
          )}

          {s.type === 'domain' && (
            <>
              <h3 style={{ fontSize: h.sec, margin: '0 0 12px' }}>{s.title}</h3>
              <div style={{ display: 'grid', gap: compact ? 12 : 22, position: 'relative', paddingLeft: s.dated ? (compact ? 16 : 22) : 0 }}>
                {s.dated && <div aria-hidden style={{ position: 'absolute', left: compact ? 4 : 6, top: 8, bottom: 8, width: 2, background: 'var(--color-neutral-300)', borderRadius: 2 }} />}
                {s.items.map((it) => {
                  const long = it.fields.filter((f) => f.type === 'longtext');
                  const short = it.fields.filter((f) => f.type !== 'longtext');
                  return (
                    <div key={it.id} style={{ position: 'relative' }}>
                      {s.dated && <span aria-hidden style={{ position: 'absolute', left: compact ? -16 : -22, top: compact ? 5 : 7, width: compact ? 10 : 14, height: compact ? 10 : 14, borderRadius: '50%', background: it.current ? 'var(--color-accent)' : 'var(--color-bg)', border: '2px solid var(--color-accent)' }} />}
                      <div style={{ fontFamily: 'var(--font-heading)', fontSize: compact ? 15 : 20, lineHeight: 1.25 }}>{it.title}</div>
                      {(it.validFrom || it.validTo) && <div className="text-muted" style={{ fontSize: compact ? 11 : 13 }}>{fmtRange(it.validFrom, it.validTo)}{it.validFrom ? ` · ${duration(it.validFrom, it.validTo)}` : ''}</div>}
                      {short.length > 0 && <div style={{ fontSize: compact ? 12 : 14, marginTop: 2 }}>{short.map((f) => f.value).join(' · ')}</div>}
                      {long.map((f) => <p key={f.key} style={{ fontSize: compact ? 12 : 15, margin: '6px 0 0', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{f.value}</p>)}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {s.type === 'resume' && (
            <>
              <h3 style={{ fontSize: h.sec, margin: '0 0 12px' }}>{s.title}</h3>
              <div className="card" style={{ padding: compact ? 12 : 16, gap: 14, flexDirection: 'row', alignItems: 'center' }}>
                <button className="bare" aria-label={`View ${s.document.title}`} onClick={() => setViewing(s.document.pages)}><Thumb page={s.document.pages[0]} url={s.document.pages[0].url} size={compact ? 52 : 72} /></button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: compact ? 13 : 15 }}>{s.document.title}</div>
                  <div className="text-muted" style={{ fontSize: 12 }}>{s.document.pages.length > 1 ? `${s.document.pages.length} pages · ` : ''}Updated {new Date(s.document.updatedAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</div>
                </div>
                <button className="btn btn-secondary" style={{ fontSize: compact ? 12 : 14 }} onClick={() => setViewing(s.document.pages)}>View</button>
                <a className="btn btn-primary" style={{ fontSize: compact ? 12 : 14 }} href={`${s.document.pages[0].url}?download=1`}>Download</a>
              </div>
            </>
          )}
        </section>
      ))}

      {!p.sections.some((s) => s.type !== 'details' || s.fields.length) && <p className="text-muted" style={{ marginTop: 32, fontSize: compact ? 13 : undefined }}>Nothing here is public yet.</p>}
      {viewing && <Lightbox title={p.displayName} pages={viewing} urlFor={(x) => (x as Page).url} onClose={() => setViewing(null)} />}
    </div>
  );
}
