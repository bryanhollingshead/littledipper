/** Shared pieces for documents: kind labels, page thumbnails, the full-screen viewer and tiles on records. */
import { useEffect, useState } from 'react';
import { bytes, fileUrl, get, type DocRef, type FileRef } from './api';

// ── kinds ──────────────────────────────────────────────────────────────
type Kinds = { kinds: [string, string][]; domains: { domain: string; label: string; kind: string }[] };
let kindsCache: Promise<Kinds> | null = null;
export function useDocKinds() {
  const [k, setK] = useState<Kinds | null>(null);
  useEffect(() => {
    kindsCache ??= get<Kinds>('/api/v1/documents/kinds').catch((e) => { kindsCache = null; throw e; });
    kindsCache.then(setK).catch(() => {});
  }, []);
  return k;
}
/** Unknown kinds (from a newer node or an app) read as "Document". */
export const kindLabel = (kinds: Kinds | null, k: string) => kinds?.kinds.find(([x]) => x === k)?.[1] ?? 'Document';

// ── pages ──────────────────────────────────────────────────────────────
export const isImage = (f: FileRef) => /^image\/(jpeg|png|webp|gif)$/.test(f.type);

/** First page of a document: the image itself, or a labelled tile for PDFs and HEIC. */
export function Thumb({ page, size = 92, url, radius = 16 }: { page: FileRef; size?: number | string; url?: string; radius?: number }) {
  const src = url ?? fileUrl(page.id);
  return (
    <span style={{ display: 'grid', placeItems: 'center', width: size, height: size, borderRadius: radius, overflow: 'hidden', background: 'var(--color-neutral-200)', color: 'var(--color-neutral-700)', fontSize: 11, flex: 'none' }}>
      {isImage(page) ? <img src={src} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : <span style={{ display: 'grid', gap: 2, justifyItems: 'center', padding: 6, textAlign: 'center' }}><strong style={{ fontSize: 13 }}>{page.type === 'application/pdf' ? 'PDF' : 'Photo'}</strong></span>}
    </span>
  );
}

/** Full-screen pages: arrows or swipe through, Esc to close. "Show card" at the pharmacy counter. */
export function Lightbox({ title, pages, start = 0, onClose, urlFor = (p) => fileUrl(p.id) }: { title: string; pages: FileRef[]; start?: number; onClose: () => void; urlFor?: (p: FileRef) => string }) {
  const [i, setI] = useState(start);
  const p = pages[i];
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((x) => Math.min(pages.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, pages.length]);
  if (!p) return null;
  const url = urlFor(p);
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(12,14,18,.92)', color: '#f3f1ec', display: 'grid', gridTemplateRows: 'auto 1fr auto', padding: 'max(12px, env(safe-area-inset-top)) 16px 16px' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 4px 12px' }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 15 }}>{title}{pages.length > 1 ? ` · ${i + 1} of ${pages.length}` : ''}</div>
        <a href={`${url}${url.includes('?') ? '&' : '?'}download=1`} style={{ color: 'inherit', fontSize: 13 }}>Download</a>
        <button className="bare" aria-label="Close" onClick={onClose} style={{ fontSize: 26, lineHeight: 1, padding: '0 6px' }}>×</button>
      </div>
      <div onClick={(e) => e.stopPropagation()} style={{ minHeight: 0, display: 'grid', placeItems: 'center' }}
        onTouchStart={(e) => ((e.currentTarget as HTMLElement).dataset.x = String(e.touches[0].clientX))}
        onTouchEnd={(e) => { const dx = e.changedTouches[0].clientX - Number((e.currentTarget as HTMLElement).dataset.x); if (Math.abs(dx) > 50) setI((x) => Math.max(0, Math.min(pages.length - 1, x + (dx < 0 ? 1 : -1)))); }}>
        {isImage(p) ? <img src={url} alt={p.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 12 }} />
          : p.type === 'application/pdf' ? <iframe title={p.name} src={url} style={{ width: 'min(900px, 100%)', height: '100%', border: 0, borderRadius: 12, background: '#fff' }} />
            : <div style={{ textAlign: 'center' }}>{p.name} · {bytes(p.size)}<br /><a href={`${url}?download=1`} style={{ color: 'inherit' }}>Download to view</a></div>}
      </div>
      {pages.length > 1 && (
        <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', justifyContent: 'center', gap: 8, paddingTop: 12 }}>
          {pages.map((x, j) => (
            <button key={x.id} className="bare" aria-label={`Page ${j + 1}`} onClick={() => setI(j)} style={{ outline: j === i ? '2px solid #f3f1ec' : 'none', borderRadius: 10, outlineOffset: 2 }}>
              <Thumb page={x} size={48} url={urlFor(x)} radius={10} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Documents linked to a record, as thumbnails. Click opens the viewer. */
export function DocTiles({ docs, size = 72, onRemove }: { docs: DocRef[]; size?: number; onRemove?: (d: DocRef) => void }) {
  const [open, setOpen] = useState<DocRef | null>(null);
  if (!docs.length) return null;
  return (
    <>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {docs.map((d) => (
          <div key={d.id} style={{ position: 'relative', flex: 'none' }}>
            <button type="button" className="bare" title={`${d.title}${d.pages.length > 1 ? ` · ${d.pages.length} pages` : ''}`} onClick={() => setOpen(d)} style={{ display: 'block', position: 'relative' }}>
              <Thumb page={d.pages[0]} size={size} />
              {d.pages.length > 1 && <span style={{ position: 'absolute', right: 6, bottom: 6, background: 'rgba(0,0,0,.6)', color: '#fff', borderRadius: 999, fontSize: 10, padding: '1px 6px' }}>{d.pages.length}</span>}
            </button>
            {onRemove && <button type="button" className="btn btn-secondary" aria-label={`Remove ${d.title}`} onClick={() => onRemove(d)} style={{ position: 'absolute', top: -6, right: -6, width: 24, height: 24, padding: 0, fontSize: 13 }}>×</button>}
          </div>
        ))}
      </div>
      {open && <Lightbox title={open.title} pages={open.pages} onClose={() => setOpen(null)} />}
    </>
  );
}
