import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { addr, ApiError, del, get, patch, put, SENS, shrink, uploadDocument, type DocFull, type Field } from '../../api';
import { ErrorNote, Loading, Pills, Toggle, useAction, useAsync, useToast } from '../../ui';
import { fmtRange, Select } from '../../life';
import { ProfileView, type ProfileViewData } from '../../profile';
import { useAdmin } from './Layout';

type Section =
  | { type: 'details' }
  | { type: 'about'; text: string }
  | { type: 'domain'; domain: string; title?: string; parts: string[]; scope: 'all' | 'current'; hidden: string[] }
  | { type: 'resume'; documentId: string; title?: string };
type PP = { displayName: string; headline: string; fieldKeys: string[]; connectRequests: 'off' | 'fof' | 'anyone'; sections: Section[]; view: ProfileViewData };
type Option = { domain: string; label: string; dated: boolean; parts: { key: string; label: string }[]; defaultParts: string[]; records: { id: string; title: string; current: boolean; validFrom: string | null; validTo: string | null }[] };

const CONNECT: [PP['connectRequests'], string, string][] = [
  ['off', 'Nobody', 'Hide the button. People can still connect with an invite link from you.'],
  ['fof', 'People my contacts know', 'Only someone already connected to one of your contacts.'],
  ['anyone', 'Anyone on Little Dipper', 'Requests from strangers wait quietly in Contacts, with no notification.'],
];
const DOMAIN_TITLES: Record<string, string> = { employment: 'Work history', education: 'Education', credentials: 'Licenses & certifications', military: 'Military service' };
/** Suggested first, then the rest of the public categories. */
const ORDER = ['employment', 'education', 'credentials', 'military'];

export default function PublicEditor() {
  const { node } = useAdmin();
  const toast = useToast();
  const { run } = useAction();
  const { data: pp, error, setData } = useAsync(() => get<PP>('/api/v1/public-profile'), []);
  const { data: fields } = useAsync(() => get<{ items: Field[] }>('/api/v1/owner/fields'), []);
  const { data: opts } = useAsync(() => get<{ domains: Option[] }>('/api/v1/public-profile/options'), []);
  const { data: docs, reload: reloadDocs } = useAsync(() => get<{ items: DocFull[] }>('/api/v1/documents?status=filed'), []);
  const [header, setHeader] = useState<{ displayName: string; headline: string } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [about, setAbout] = useState<Record<number, string>>({});
  const timer = useRef<number | undefined>(undefined);
  const aboutTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (pp && !header) setHeader({ displayName: pp.displayName, headline: pp.headline });
  }, [pp, header]);

  if (error) return <ErrorNote error={error} />;
  if (!pp || !fields || !header || !opts) return <Loading />;

  const save = async (body: Partial<Omit<PP, 'view'>>) => {
    const r = await run(() => put<PP>('/api/v1/public-profile', body));
    if (r) setData(r);
  };
  const editHeader = (k: 'displayName' | 'headline', v: string) => {
    setHeader({ ...header, [k]: v });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save({ [k]: v }), 500);
  };
  const setSections = (sections: Section[]) => { setData({ ...pp, sections }); save({ sections }); };
  const update = (i: number, s: Section) => setSections(pp.sections.map((x, j) => (j === i ? s : x)));
  const move = (i: number, by: number) => {
    const next = [...pp.sections];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s);
    setSections(next);
    setOpen(open === i ? i + by : open);
  };
  const remove = (i: number) => { setSections(pp.sections.filter((_, j) => j !== i)); setOpen(null); };
  const add = (s: Section) => { setSections([...pp.sections, s]); setOpen(pp.sections.length); };
  const toggleField = (key: string) => save({ fieldKeys: pp.fieldKeys.includes(key) ? pp.fieldKeys.filter((k) => k !== key) : [...pp.fieldKeys, key] });

  const photo = async (f: File | undefined) => {
    if (!f) return;
    const img = await shrink(f);
    const res = await fetch(`/api/v1/public-profile/avatar?name=${encodeURIComponent(f.name)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': img.type || f.type }, body: img });
    const data = await res.json().catch(() => null);
    if (!res.ok) return toast(new ApiError(res.status, data?.code, data?.message || 'Upload failed').message);
    setData({ ...pp, view: { ...pp.view, avatarUrl: data.avatarUrl } });
  };
  const dropPhoto = async () => { if (await run(() => del('/api/v1/public-profile/avatar'))) setData({ ...pp, view: { ...pp.view, avatarUrl: null } }); };

  const domainOpt = (id: string) => opts.domains.find((d) => d.domain === id);
  const nameOf = (s: Section) => s.type === 'details' ? 'Details' : s.type === 'about' ? 'About' : s.type === 'resume' ? (s.title || 'Résumé') : (s.title || DOMAIN_TITLES[s.domain] || domainOpt(s.domain)?.label || s.domain);
  const blurb = (s: Section) => {
    if (s.type === 'details') return `${pp.fieldKeys.length} field${pp.fieldKeys.length === 1 ? '' : 's'} shown`;
    if (s.type === 'about') return s.text ? s.text.slice(0, 60) + (s.text.length > 60 ? '…' : '') : 'Empty: hidden until you write something';
    if (s.type === 'resume') return docs?.items.find((d) => d.id === s.documentId)?.title ?? 'Document missing';
    const o = domainOpt(s.domain);
    const n = (o?.records ?? []).filter((r) => !s.hidden.includes(r.id) && (s.scope === 'all' || r.current)).length;
    return `${n} of ${o?.records.length ?? 0} shown`;
  };

  const addable = [
    ...(!pp.sections.some((s) => s.type === 'about') ? [{ label: 'About', s: { type: 'about', text: '' } as Section }] : []),
    ...(!pp.sections.some((s) => s.type === 'details') ? [{ label: 'Details', s: { type: 'details' } as Section }] : []),
    ...[...opts.domains].sort((a, b) => (ORDER.indexOf(a.domain) + 1 || 99) - (ORDER.indexOf(b.domain) + 1 || 99))
      .filter((o) => !pp.sections.some((s) => s.type === 'domain' && s.domain === o.domain))
      .map((o) => ({ label: DOMAIN_TITLES[o.domain] ?? o.label, s: { type: 'domain', domain: o.domain, parts: o.defaultParts, scope: 'all', hidden: [] } as Section })),
    ...(!pp.sections.some((s) => s.type === 'resume') ? [{ label: 'Résumé', s: null }] : []),
  ];
  const resumeDocs = [...(docs?.items ?? [])].sort((a, b) => Number(b.kind === 'resume') - Number(a.kind === 'resume'));
  const uploadResume = async (f: File | undefined, i?: number) => {
    if (!f) return;
    const doc = await run(() => uploadDocument(f, { kind: 'resume' }));
    if (!doc) return;
    reloadDocs();
    // An upload from here is filed straight away: it's going on the profile.
    await patch(`/api/v1/documents/${doc.id}`, { status: 'filed', title: 'Résumé' }).catch(() => {});
    if (i === undefined) add({ type: 'resume', documentId: doc.id });
    else update(i, { type: 'resume', documentId: doc.id });
  };

  return (
    <div data-screen-label="Public profile editor" style={{ maxWidth: 1180 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>Public profile</h1><p className="text-muted" style={{ margin: 0 }}>What anyone visiting <span className="mono">{addr(node.address)}</span> can see. Secret details can never be shown.</p></div>
        <Link className="btn btn-primary" to="/">View as visitor</Link>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,440px),1fr))', gap: 24, marginTop: 26, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 20 }}>
          <div className="card" style={{ padding: '20px 24px', gap: 14 }}>
            <div className="card-kicker">Header</div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              {pp.view.avatarUrl ? <img src={pp.view.avatarUrl} alt="" style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }} /> : <span style={{ width: 64, height: 64, borderRadius: '50%', border: '1.5px dashed var(--color-neutral-400)', display: 'grid', placeItems: 'center', fontSize: 11 }} className="text-muted">No photo</span>}
              <label className="btn btn-secondary" style={{ cursor: 'pointer', fontSize: 13 }}>{pp.view.avatarUrl ? 'Change photo' : 'Add a photo'}<input type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { photo(e.target.files?.[0]); e.target.value = ''; }} /></label>
              {pp.view.avatarUrl && <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={dropPhoto}>Remove</button>}
            </div>
            <div className="field"><label htmlFor="dn">Display name</label><input id="dn" className="input" value={header.displayName} onChange={(e) => editHeader('displayName', e.target.value)} /></div>
            <div className="field"><label htmlFor="hl">Headline</label><input id="hl" className="input" value={header.headline} placeholder="What you'd like people to know first" onChange={(e) => editHeader('headline', e.target.value)} /></div>
          </div>

          <div className="card" style={{ padding: '20px 24px', gap: 10 }}>
            <div className="card-kicker">Sections</div>
            <div className="text-muted" style={{ fontSize: 13 }}>Shown in this order below your name. Add what you want people to see; new entries in a section appear automatically.</div>
            {pp.sections.map((s, i) => (
              <div key={`${s.type}-${s.type === 'domain' ? s.domain : i}`} style={{ border: '1px solid var(--color-divider)', borderRadius: 20, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: open === i ? 'var(--color-neutral-100)' : undefined }}>
                  <button className="bare" onClick={() => setOpen(open === i ? null : i)} style={{ flex: 1, minWidth: 0 }} aria-expanded={open === i}>
                    <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{nameOf(s)}</span>
                    <span className="text-muted" style={{ display: 'block', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{blurb(s)}</span>
                  </button>
                  <button className="btn btn-ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} style={{ padding: '4px 8px' }}>↑</button>
                  <button className="btn btn-ghost" aria-label="Move down" disabled={i === pp.sections.length - 1} onClick={() => move(i, 1)} style={{ padding: '4px 8px' }}>↓</button>
                  <button className="btn btn-ghost" aria-label={`Remove ${nameOf(s)}`} onClick={() => remove(i)} style={{ padding: '4px 8px' }}>×</button>
                </div>
                {open === i && (
                  <div style={{ padding: '6px 14px 14px', display: 'grid', gap: 10 }}>
                    {s.type === 'details' && fields.items.map((f) => {
                      const locked = f.sensitivity === 'secret';
                      const on = pp.fieldKeys.includes(f.key);
                      return (
                        <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--color-divider)' }}>
                          <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14 }}>{f.label}</div><div className="text-muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{locked ? 'Secret fields are never public' : !f.hasValue ? 'Not added yet: shows once you add it' : on ? f.value : 'Hidden'}</div></div>
                          <span className={`tag ${SENS[f.sensitivity][1]}`}>{SENS[f.sensitivity][0]}</span>
                          {locked ? <span className="tag tag-neutral" style={{ width: 64, justifyContent: 'center' }}>Never</span> : <Toggle on={on} label={`Show ${f.label} publicly`} onChange={() => toggleField(f.key)} />}
                        </div>
                      );
                    })}

                    {s.type === 'about' && (
                      <textarea className="input" aria-label="About" style={{ borderRadius: 20, minHeight: 110 }} placeholder="A few sentences about you, in your own words." maxLength={3000}
                        value={about[i] ?? s.text} onChange={(e) => { const text = e.target.value; setAbout({ ...about, [i]: text }); clearTimeout(aboutTimer.current); aboutTimer.current = window.setTimeout(() => update(i, { type: 'about', text }), 600); }} />
                    )}

                    {s.type === 'domain' && (() => {
                      const o = domainOpt(s.domain);
                      if (!o) return <div className="text-muted" style={{ fontSize: 13 }}>This category is no longer available.</div>;
                      return (
                        <>
                          <div className="field"><label>Show</label>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {o.parts.map((p) => {
                                const on = s.parts.includes(p.key);
                                return <button key={p.key} type="button" className={`tag ${on ? 'tag-accent-2' : 'tag-outline'}`} aria-pressed={on} onClick={() => update(i, { ...s, parts: on ? s.parts.filter((k) => k !== p.key) : [...s.parts, p.key] })} style={{ cursor: 'pointer', border: on ? undefined : '1px solid var(--color-neutral-300)' }}>{p.label}</button>;
                              })}
                            </div>
                          </div>
                          {o.dated && <div className="field"><label>Entries</label><Pills value={s.scope} options={[['all', 'All, past and present'], ['current', 'Current only']]} onChange={(v) => update(i, { ...s, scope: v })} size={12} /></div>}
                          {o.records.length === 0 ? <div className="text-muted" style={{ fontSize: 13 }}>No entries yet. <Link to={`/admin/life/${o.domain}`}>Add one in My data</Link></div> : o.records.map((r) => {
                            const on = !s.hidden.includes(r.id) && (s.scope === 'all' || r.current);
                            return (
                              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <div style={{ flex: 1, minWidth: 0, opacity: s.scope === 'current' && !r.current ? 0.5 : 1 }}><div style={{ fontSize: 14 }}>{r.title}</div>{(r.validFrom || r.validTo) && <div className="text-muted" style={{ fontSize: 12 }}>{fmtRange(r.validFrom, r.validTo)}</div>}</div>
                                <Toggle on={on} label={`Show ${r.title}`} onChange={() => update(i, { ...s, hidden: s.hidden.includes(r.id) ? s.hidden.filter((x) => x !== r.id) : [...s.hidden, r.id] })} />
                              </div>
                            );
                          })}
                        </>
                      );
                    })()}

                    {s.type === 'resume' && (
                      <div style={{ display: 'grid', gap: 8 }}>
                        <Select value={s.documentId} onChange={(v) => v && update(i, { ...s, documentId: v })} options={resumeDocs.map((d) => [d.id, d.title])} placeholder="Choose a document" />
                        <label className="btn btn-secondary" style={{ cursor: 'pointer', justifySelf: 'start', fontSize: 13 }}>Upload a new version<input type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(e) => { uploadResume(e.target.files?.[0], i); e.target.value = ''; }} /></label>
                        <div className="text-muted" style={{ fontSize: 12 }}>Visitors can view and download it. Your other documents stay private.</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {addable.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
                <span className="text-muted" style={{ fontSize: 13 }}>Add:</span>
                {addable.map((a) => a.s ? (
                  <button key={a.label} className="btn btn-secondary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => add(a.s!)}>+ {a.label}</button>
                ) : resumeDocs.length ? (
                  <button key={a.label} className="btn btn-secondary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => add({ type: 'resume', documentId: resumeDocs[0].id })}>+ {a.label}</button>
                ) : (
                  <label key={a.label} className="btn btn-secondary" style={{ fontSize: 12, padding: '5px 12px', cursor: 'pointer' }}>+ {a.label}<input type="file" accept="application/pdf,image/jpeg,image/png" hidden onChange={(e) => { uploadResume(e.target.files?.[0]); e.target.value = ''; }} /></label>
                ))}
              </div>
            )}
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
          <div className="text-muted" style={{ fontSize: 12, marginBottom: 8 }}>Live preview: exactly what visitors see</div>
          <div style={{ borderRadius: 32, background: 'var(--color-neutral-100)', boxShadow: 'var(--shadow-md)', padding: 28, position: 'relative', overflow: 'hidden', maxHeight: 'calc(100vh - 80px)', overflowY: 'auto' }}>
            <div aria-hidden style={{ position: 'absolute', right: -80, top: -60, width: 220, height: 220, borderRadius: '50%', background: 'var(--color-accent-200)', opacity: 0.6 }} />
            <div style={{ position: 'relative' }}>
              <ProfileView p={{ ...pp.view, displayName: header.displayName, headline: header.headline }} compact />
              <div style={{ display: 'flex', gap: 6, marginTop: 20, flexWrap: 'wrap' }}>
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
