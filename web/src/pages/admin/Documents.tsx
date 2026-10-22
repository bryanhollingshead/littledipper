import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { addPage, copy, del, FILE_ACCEPT, get, longDate, patch, post, uploadDocument, type DocFull, type Share, type Suggestion } from '../../api';
import { Confirm, ErrorNote, Loading, Pills, useAction, useAsync, useToast, type ConfirmCfg } from '../../ui';
import { fetchCatalog, fmtDate, groupOf, GROUPS, PartialDate, RecordEditor, Select, show, useContactsLite, type ContactLite, type Domain, type Rec } from '../../life';
import { kindLabel, Lightbox, Thumb, useDocKinds } from '../../docs';
import { useAdmin } from './Layout';

type View = 'grid' | 'list';
const VIEW_KEY = 'ld.documents.view';
const readView = (): View => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } };

/** "Driver’s license · WA · Expires 1 May 2030": the first few values of a suggestion, in words. */
function summary(d: Domain | undefined, s: Suggestion, contacts: ContactLite[]) {
  if (!d) return s.domain;
  return d.parts.filter((p) => s.data[p.key] !== undefined && s.data[p.key] !== '' && p.type !== 'list').slice(0, 4)
    .map((p) => (p.type === 'date' ? `${p.label} ${show(p, s.data[p.key], contacts)}` : show(p, s.data[p.key], contacts))).join(' · ');
}

const fromLabel = (doc: DocFull) => (doc.from.type === 'owner' ? 'You' : doc.from.type === 'app' ? 'An app' : doc.from.type === 'peer' ? 'A contact' : 'Little Dipper');

export default function Documents() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { refresh } = useAdmin();
  const kinds = useDocKinds();
  const contacts = useContactsLite();
  const { data: catalog } = useAsync(fetchCatalog, []);
  const { data, error, reload } = useAsync(() => get<{ items: DocFull[] }>('/api/v1/documents'), []);
  const [view, setView] = useState<View>(readView);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<{ doc: DocFull; s: Suggestion } | null>(null);
  const { run } = useAction();

  const all = data?.items ?? [];
  const groupOfDoc = (doc: DocFull) => catalog?.find((d) => d.id === doc.links[0]?.domain)?.group;
  const inbox = all.filter((x) => x.status === 'inbox');
  const filters = useMemo(() => {
    const groups = GROUPS.filter((g) => all.some((x) => x.status === 'filed' && groupOfDoc(x) === g.id)).map((g) => [g.id, g.label] as [string, string]);
    const hasLoose = all.some((x) => x.status === 'filed' && !x.links.length);
    return [['all', 'Everything'], ...groups, ...(hasLoose ? [['loose', 'Not linked'] as [string, string]] : [])] as [string, string][];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, catalog]);
  const library = all.filter((x) => x.status === 'filed')
    .filter((x) => filter === 'all' || (filter === 'loose' ? !x.links.length : groupOfDoc(x) === filter))
    .filter((x) => { const n = q.trim().toLowerCase(); return !n || [x.title, x.notes, x.text, kindLabel(kinds, x.kind), ...x.links.map((l) => `${l.domainLabel} ${l.title ?? ''}`)].join(' ').toLowerCase().includes(n); });

  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch { /* private window */ } }, [view]);

  if (error) return <ErrorNote error={error} />;
  if (!data || !catalog) return <Loading />;

  const changed = () => { reload(); refresh(); };
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(files.length);
    for (const f of files) {
      try { await uploadDocument(f); } catch (e) { toast(`${f.name}: ${(e as Error).message}`); }
      setUploading((n) => n - 1);
    }
    changed();
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); upload(Array.from(e.dataTransfer.files)); };
  const accept = async (doc: DocFull, s: Suggestion) => { if (await run(() => post(`/api/v1/documents/${doc.id}/suggestions/${s.id}/accept`, {}), 'Added and filed')) changed(); };
  const dismiss = async (doc: DocFull, s: Suggestion) => { if (await run(() => del(`/api/v1/documents/${doc.id}/suggestions/${s.id}`))) changed(); };
  const fileIt = async (doc: DocFull) => { if (await run(() => patch(`/api/v1/documents/${doc.id}`, { status: 'filed' }))) changed(); };

  const open = all.find((x) => x.id === id);

  return (
    <div data-screen-label="Documents" style={{ maxWidth: 1100, position: 'relative' }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={onDrop}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>Documents</h1>
          <p className="text-muted" style={{ margin: 0, maxWidth: 620 }}>Scans, photos and PDFs: IDs, insurance cards, leases, statements. New ones wait in the inbox until they’re filed, by you or your assistant.</p>
        </div>
        <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
          {uploading ? `Uploading ${uploading}…` : 'Upload'}
          <input type="file" accept={FILE_ACCEPT} multiple hidden onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        </label>
      </div>

      {dragging && (
        <div style={{ position: 'absolute', inset: -12, zIndex: 5, borderRadius: 32, border: '2px dashed var(--color-accent-500)', background: 'color-mix(in srgb, var(--color-accent-100) 85%, transparent)', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-heading)', fontSize: 22, pointerEvents: 'none' }}>
          Drop to add to your inbox
        </div>
      )}

      {all.length === 0 && (
        <div className="card" style={{ marginTop: 24, padding: '34px 30px', gap: 10, alignItems: 'flex-start', background: 'var(--color-accent-100)' }}>
          <div className="card-title" style={{ fontSize: 22 }}>No documents yet</div>
          <div style={{ fontSize: 14, maxWidth: 560 }}>Upload or drag in a scan of your license, an insurance card or a lease. You can also add documents straight from an entry in My data: they show up here too.</div>
        </div>
      )}

      {inbox.length > 0 && (
        <section style={{ marginTop: 26 }}>
          <h4 style={{ marginBottom: 10 }}>Inbox · {inbox.length}</h4>
          <div style={{ display: 'grid', gap: 10 }}>
            {inbox.map((doc) => (
              <div key={doc.id} className="card" style={{ padding: '14px 16px', gap: 10, background: 'var(--color-accent-100)' }}>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className="bare" onClick={() => nav(`/admin/documents/${doc.id}`)} aria-label={`Open ${doc.title}`}><Thumb page={doc.pages[0]} size={64} /></button>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <button className="bare" onClick={() => nav(`/admin/documents/${doc.id}`)} style={{ fontWeight: 600 }}>{doc.title}</button>
                    <div className="text-muted" style={{ fontSize: 12 }}>{kindLabel(kinds, doc.kind)} · {fromLabel(doc)} · {longDate(doc.createdAt)}{doc.pages.length > 1 ? ` · ${doc.pages.length} pages` : ''}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => nav(`/admin/documents/${doc.id}`)}>Open</button>
                    <button className="btn btn-secondary" style={{ fontSize: 13 }} onClick={() => fileIt(doc)}>File it</button>
                  </div>
                </div>
                {doc.suggestions.map((s) => {
                  const d = catalog.find((x) => x.id === s.domain);
                  return (
                    <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', background: 'var(--color-bg)', borderRadius: 18, padding: '10px 14px' }}>
                      <span className="tag tag-accent-2">Suggestion</span>
                      <span style={{ flex: 1, minWidth: 200, fontSize: 13 }}>
                        <strong>{s.recordId ? 'Update' : 'Add to'} {d?.label ?? s.domain}:</strong> {summary(d, s, contacts)}
                        {s.note && <span className="text-muted"> · {s.note}</span>}
                      </span>
                      <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => accept(doc, s)}>Accept</button>
                      {!s.recordId && d && <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => setEditing({ doc, s })}>Edit</button>}
                      <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => dismiss(doc, s)}>Dismiss</button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      )}

      {all.some((x) => x.status === 'filed') && (
        <section style={{ marginTop: 26 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
            <h4 style={{ margin: 0 }}>Library</h4>
            {filters.length > 2 && <Pills value={filter} options={filters} onChange={setFilter} size={12} />}
            <input className="input" type="search" placeholder="Search titles, text, notes…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 180px', maxWidth: 300 }} />
            <span style={{ flex: 1 }} />
            <Pills value={view} options={[['grid', 'Grid'], ['list', 'List']]} onChange={setView} size={12} />
          </div>
          {library.length === 0 ? <p className="text-muted" style={{ fontSize: 14 }}>Nothing matches.</p> : view === 'grid' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
              {library.map((doc) => (
                <button key={doc.id} className="bare card" onClick={() => nav(`/admin/documents/${doc.id}`)} style={{ padding: 10, gap: 8, minWidth: 0 }}>
                  <span style={{ position: 'relative', display: 'block', aspectRatio: '4 / 3' }}>
                    <Thumb page={doc.pages[0]} size="100%" radius={14} />
                    {doc.pages.length > 1 && <span style={{ position: 'absolute', right: 6, bottom: 6, background: 'rgba(0,0,0,.6)', color: '#fff', borderRadius: 999, fontSize: 10, padding: '1px 6px' }}>{doc.pages.length}</span>}
                  </span>
                  <span style={{ display: 'block', padding: '0 4px', minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</span>
                    <span className="text-muted" style={{ display: 'block', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{kindLabel(kinds, doc.kind)}{doc.links[0] ? ` · ${doc.links[0].domainLabel}` : ''}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {library.map((doc) => (
                <button key={doc.id} className="bare card" onClick={() => nav(`/admin/documents/${doc.id}`)} style={{ padding: '8px 14px', gap: 12, flexDirection: 'row', alignItems: 'center' }}>
                  <Thumb page={doc.pages[0]} size={40} radius={10} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</span>
                    <span className="text-muted" style={{ display: 'block', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{kindLabel(kinds, doc.kind)}{doc.links.length ? ` · ${doc.links.map((l) => l.title ?? l.domainLabel).join(', ')}` : ''}</span>
                  </span>
                  <span className="text-muted" style={{ fontSize: 12, flex: 'none' }}>{doc.date ? fmtDate(doc.date) : longDate(doc.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {open && <DocumentPanel key={open.id} doc={open} catalog={catalog} contacts={contacts} onClose={() => nav('/admin/documents')} onChange={changed} />}
      {id && data && !open && <Missing onClose={() => nav('/admin/documents')} />}

      {editing && (() => {
        const d = catalog.find((x) => x.id === editing.s.domain)!;
        return (
          <RecordEditor d={d} rec={null} contacts={contacts} defaults={editing.s.data} onClose={() => setEditing(null)}
            onSaved={async (saved?: Rec) => {
              // Saved by hand from the suggestion: link the document, file it, clear the suggestion.
              if (saved) {
                await patch(`/api/v1/documents/${editing.doc.id}`, { links: [...editing.doc.links.map(({ domain, recordId }) => ({ domain, recordId })), { domain: d.id, recordId: saved.id }], status: 'filed' });
                await del(`/api/v1/documents/${editing.doc.id}/suggestions/${editing.s.id}`);
              }
              setEditing(null);
              changed();
            }} />
        );
      })()}
    </div>
  );
}

function Missing({ onClose }: { onClose: () => void }) {
  useEffect(() => { onClose(); }, [onClose]);
  return null;
}

const EXPIRY: [string, string][] = [['1', '1 hour'], ['24', '1 day'], ['168', '7 days'], ['720', '30 days']];

/** One document: pages, details, what it's linked to, share links. A side panel over the library. */
function DocumentPanel({ doc, catalog, contacts, onClose, onChange }: { doc: DocFull; catalog: Domain[]; contacts: ContactLite[]; onClose: () => void; onChange: () => void }) {
  const toast = useToast();
  const kinds = useDocKinds();
  const { run, busy } = useAction();
  const [title, setTitle] = useState(doc.title);
  const [notes, setNotes] = useState(doc.notes);
  const [date, setDate] = useState(doc.date ?? '');
  const [viewing, setViewing] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [linkDomain, setLinkDomain] = useState('');
  const [hours, setHours] = useState('168');
  const [newUrl, setNewUrl] = useState('');
  const [showText, setShowText] = useState(false);
  const { data: shares, reload: reloadShares } = useAsync(() => get<{ items: Share[] }>(`/api/v1/documents/${doc.id}/shares`), [doc.id]);
  const { data: candidates } = useAsync(() => (linkDomain ? get<{ items: Rec[] }>(`/api/v1/${linkDomain}`) : Promise.resolve({ items: [] as Rec[] })), [linkDomain]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && viewing === null && !confirm && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, viewing, confirm]);

  const save = async (body: Record<string, unknown>) => { if (await run(() => patch(`/api/v1/documents/${doc.id}`, body))) onChange(); };
  const links = doc.links.map(({ domain, recordId }) => ({ domain, recordId }));
  const share = async () => {
    const r = await run(() => post<{ url: string }>(`/api/v1/documents/${doc.id}/shares`, { hours: Number(hours) }));
    if (r) { setNewUrl(r.url); reloadShares(); toast((await copy(r.url)) ? 'Link copied' : 'Link created'); }
  };
  const unshare = async (s: Share) => { if (await run(() => del(`/api/v1/documents/${doc.id}/shares/${s.id}`))) reloadShares(); };
  const remove = () => setConfirm({
    title: 'Delete this document?', body: `${doc.title} and its ${doc.pages.length === 1 ? 'page' : `${doc.pages.length} pages`} are deleted, and any share links stop working.`, cta: 'Delete',
    onConfirm: async () => { if (await run(() => del(`/api/v1/documents/${doc.id}`))) { onChange(); onClose(); } },
  });
  const linkable = catalog.filter((d) => d.documents || d.count > 0);

  return (
    <div className="dialog-backdrop" style={{ zIndex: 50, placeItems: 'stretch end', padding: 0 }} onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label={doc.title} onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(600px, 100%)', height: '100%', background: 'var(--color-bg)', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', borderRadius: '32px 0 0 32px' }}>
        <div style={{ padding: '22px 26px 12px', display: 'flex', gap: 12, alignItems: 'center' }}>
          <input className="input" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title.trim() && title !== doc.title && save({ title })}
            style={{ flex: 1, fontFamily: 'var(--font-heading)', fontSize: 20, background: 'transparent', border: '1px solid transparent', paddingLeft: 8 }} />
          <button className="btn btn-secondary" onClick={onClose} aria-label="Close" style={{ width: 36, height: 36, padding: 0 }}>×</button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '0 26px 24px', display: 'grid', gap: 18, alignContent: 'start' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            {doc.pages.map((p, i) => (
              <div key={p.id} style={{ position: 'relative' }}>
                <button className="bare" onClick={() => setViewing(i)} aria-label={`View page ${i + 1}`}><Thumb page={p} size={110} /></button>
                {doc.pages.length > 1 && <button className="btn btn-secondary" aria-label={`Remove page ${i + 1}`} onClick={async () => { if (await run(() => del(`/api/v1/documents/${doc.id}/pages/${p.id}`))) onChange(); }} style={{ position: 'absolute', top: -6, right: -6, width: 24, height: 24, padding: 0, fontSize: 13 }}>×</button>}
              </div>
            ))}
            <label style={{ width: 110, height: 110, borderRadius: 16, border: '1.5px dashed var(--color-neutral-400)', display: 'grid', placeItems: 'center', textAlign: 'center', fontSize: 12, cursor: 'pointer', color: 'var(--color-neutral-700)' }}>
              + Add a page
              <input type="file" accept={FILE_ACCEPT} hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && await run(() => addPage(doc.id, f))) onChange(); }} />
            </label>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div className="field"><label htmlFor="dkind">Type</label><Select id="dkind" value={doc.kind} onChange={(v) => v && save({ kind: v })} options={kinds?.kinds ?? [[doc.kind, kindLabel(kinds, doc.kind)]]} /></div>
            <div className="field"><label>Status</label><Pills value={doc.status} options={[['inbox', 'Inbox'], ['filed', 'Filed']]} onChange={(v) => save({ status: v })} size={12} /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label htmlFor="ddate">Date on the document</label><PartialDate id="ddate" value={date} onChange={(v) => { setDate(v); if (!v || /^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) save({ date: v || null }); }} /></div>
          </div>

          <div className="field">
            <label>Linked to</label>
            {doc.links.length === 0 && <div className="text-muted" style={{ fontSize: 13 }}>Not linked to anything in My data yet.</div>}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {doc.links.map((l) => (
                <span key={l.recordId} className="tag tag-neutral" style={{ gap: 6, padding: '4px 10px', ...{ background: groupOf(catalog.find((d) => d.id === l.domain)?.group ?? 'custom').wash } }}>
                  <Link to={`/admin/life/${l.domain}`} style={{ color: 'inherit' }}>{l.domainLabel}{l.title ? ` · ${l.title}` : ''}</Link>
                  <button className="bare" aria-label="Unlink" onClick={() => save({ links: links.filter((x) => x.recordId !== l.recordId) })}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
              <Select value={linkDomain} onChange={setLinkDomain} options={linkable.map((d) => [d.id, d.label])} placeholder="Link to a category…" />
              {linkDomain && <Select value="" onChange={(rid) => { if (rid) { save({ links: [...links, { domain: linkDomain, recordId: rid }], status: 'filed' }); setLinkDomain(''); } }}
                options={(candidates?.items ?? []).filter((r) => !links.some((l) => l.recordId === r.id)).map((r) => [r.id, r.title])} placeholder={candidates?.items.length ? 'Choose an entry…' : 'No entries yet'} />}
            </div>
          </div>

          {doc.suggestions.length > 0 && (
            <div className="field">
              <label>Suggestions</label>
              {doc.suggestions.map((s) => (
                <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13, background: 'var(--color-accent-100)', borderRadius: 16, padding: '8px 12px' }}>
                  <span style={{ flex: 1, minWidth: 180 }}><strong>{catalog.find((d) => d.id === s.domain)?.label}:</strong> {summary(catalog.find((d) => d.id === s.domain), s, contacts)}</span>
                  <button className="btn btn-primary" style={{ fontSize: 12 }} disabled={busy} onClick={async () => { if (await run(() => post(`/api/v1/documents/${doc.id}/suggestions/${s.id}/accept`, {}), 'Added and filed')) onChange(); }}>Accept</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => { if (await run(() => del(`/api/v1/documents/${doc.id}/suggestions/${s.id}`))) onChange(); }}>Dismiss</button>
                </div>
              ))}
            </div>
          )}

          <div className="field">
            <label>Share with someone not on Little Dipper</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>Link works for</span>
              <Select value={hours} onChange={(v) => v && setHours(v)} options={EXPIRY} style={{ width: 130 }} />
              <button className="btn btn-secondary" style={{ fontSize: 13 }} disabled={busy} onClick={share}>Create link</button>
            </div>
            {newUrl && <div className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', background: 'var(--color-neutral-200)', borderRadius: 12, padding: '8px 10px' }}>{newUrl}</div>}
            {shares?.items.filter((s) => s.active).map((s) => (
              <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                <span className="text-muted" style={{ flex: 1 }}>Link expires {longDate(s.expiresAt)} · opened {s.views} time{s.views === 1 ? '' : 's'}</span>
                <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => unshare(s)}>Turn off</button>
              </div>
            ))}
          </div>

          <div className="field"><label htmlFor="dnotes">Notes</label><textarea id="dnotes" className="input" style={{ borderRadius: 20, minHeight: 60 }} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== doc.notes && save({ notes })} /></div>

          {doc.text && (
            <div className="field">
              <button type="button" className="btn btn-ghost" style={{ justifySelf: 'start', fontSize: 13 }} onClick={() => setShowText(!showText)}>{showText ? 'Hide text' : 'Text read from this document'}</button>
              {showText && <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0, background: 'var(--color-neutral-100)', borderRadius: 16, padding: 12, maxHeight: 260, overflow: 'auto' }}>{doc.text}</pre>}
            </div>
          )}
          <div className="text-muted" style={{ fontSize: 12 }}>Added {longDate(doc.createdAt)} by {fromLabel(doc).toLowerCase()}</div>
        </div>
        <div style={{ padding: '14px 26px 22px', display: 'flex', gap: 8, borderTop: '1px solid var(--color-divider)' }}>
          <button className="btn btn-ghost" onClick={remove} style={{ color: 'var(--color-accent-700)', marginRight: 'auto' }}>Delete</button>
          <button className="btn btn-primary" onClick={() => setViewing(0)}>View</button>
        </div>
      </aside>
      {viewing !== null && <Lightbox title={doc.title} pages={doc.pages} start={viewing} onClose={() => setViewing(null)} />}
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
