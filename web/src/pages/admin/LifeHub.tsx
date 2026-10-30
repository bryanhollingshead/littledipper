import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post, type Field } from '../../api';
import { Dialog, ErrorNote, Loading, Pills, useAction, useAsync } from '../../ui';
import { fetchCatalog, fmtDate, groupOf, Lock, Mono, Section, Select, useGrouped, type Domain } from '../../life';

type Attention = { domain: string; domainLabel: string; id: string; title: string; part: string; date: string; expired: boolean };

export default function LifeHub() {
  const nav = useNavigate();
  const { data: domains, error, reload } = useAsync(fetchCatalog, []);
  const { data: fields } = useAsync(() => get<{ items: Field[] }>('/api/v1/owner/fields'), []);
  const { data: attention } = useAsync(() => get<{ items: Attention[] }>('/api/v1/attention'), []);
  const { data: timeline } = useAsync(() => get<{ items: { validFrom: string }[] }>('/api/v1/timeline'), []);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const grouped = useGrouped(domains?.filter((d) => !q || `${d.label} ${d.description}`.toLowerCase().includes(q.toLowerCase())));

  if (error) return <ErrorNote error={error} />;
  if (!domains) return <Loading />;

  const started = domains.filter((d) => d.count > 0).length;
  const entries = domains.reduce((n, d) => n + d.count, 0);
  const filled = fields?.items.filter((f) => f.hasValue).length ?? 0;
  const years = timeline?.items.length ? new Date().getFullYear() - +timeline.items[timeline.items.length - 1].validFrom.slice(0, 4) : 0;
  const core = fields?.items.filter((f) => ['legal_name', 'preferred_name', 'dob'].includes(f.key)) ?? [];

  return (
    <div data-screen-label="My data" style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>My data</h1>
          <p className="text-muted" style={{ margin: 0, maxWidth: 640 }}>Everything about you, kept in one place. Only you see this page. You choose, category by category, what each contact and each app can see.</p>
        </div>
        <input className="input" aria-label="Find a category" placeholder="Find a category" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
      </div>

      {!q && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,300px),1fr))', gap: 18, marginTop: 26 }}>
          <Link to="/admin/life/profile" className="card" style={{ padding: '22px 24px', gap: 10, textDecoration: 'none', color: 'inherit' }}>
            <div className="card-kicker">Profile basics</div>
            <div className="card-title" style={{ fontSize: 22 }}>{core.find((f) => f.key === 'legal_name')?.value || 'Your name'}</div>
            <div className="card-body">{filled} core facts · your basic profile and public page are built from these</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {core.filter((f) => f.key !== 'legal_name').map((f) => <span key={f.key} className="tag tag-neutral">{f.label}: {f.value || '—'}</span>)}
            </div>
          </Link>
          <Link to="/admin/lifestream" className="card" style={{ padding: '22px 24px', gap: 10, textDecoration: 'none', color: 'inherit', background: 'var(--color-accent-2-100)', position: 'relative', overflow: 'hidden' }}>
            <div className="card-kicker" style={{ color: 'var(--color-accent-2-800)' }}>Lifestream</div>
            <div className="card-title" style={{ fontSize: 22 }}>{timeline?.items.length ? `${timeline.items.length} moments${years ? ` across ${years} years` : ''}` : 'Your story starts here'}</div>
            <div className="card-body">Homes, jobs, schools and milestones, laid out in order. Background checks and applications ask for exactly this.</div>
            <TimelineSpark n={timeline?.items.length ?? 0} />
          </Link>
          <div className="card" style={{ padding: '22px 24px', gap: 10, background: attention?.items.length ? 'var(--color-accent-100)' : undefined }}>
            <div className="card-kicker">Coming up</div>
            {attention?.items.length ? attention.items.slice(0, 3).map((a) => (
              <button key={a.id + a.part} className="bare" onClick={() => nav(`/admin/life/${a.domain}`)} style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: a.expired ? 'var(--color-accent-700)' : 'var(--color-accent-400)', flex: 'none' }} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 14 }}><strong style={{ fontWeight: 600 }}>{a.title}</strong><span className="text-muted"> · {a.part.toLowerCase()} {fmtDate(a.date)}</span></span>
                {a.expired && <span className="tag tag-accent">Expired</span>}
              </button>
            )) : <div className="card-body">Nothing expires in the next six months. Add expiry dates to IDs, licenses and registrations and they’ll show up here.</div>}
          </div>
        </div>
      )}

      {!q && (
        <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'center', marginTop: 22, fontSize: 13 }} className="text-muted">
          <span><strong style={{ color: 'var(--color-text)' }}>{started}</strong> of {domains.length} categories started</span>
          <span><strong style={{ color: 'var(--color-text)' }}>{entries}</strong> entries</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Lock style={{ color: 'var(--color-accent-700)' }} /> Secret details are encrypted and never leave without your confirmation</span>
        </div>
      )}

      {grouped.map(({ g, items }) => (
        <Section key={g.id} title={g.label} blurb={g.blurb} ink={g.ink} right={g.id === 'custom' ? <button className="btn btn-ghost" onClick={() => setCreating(true)}>New category</button> : undefined}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(min(100%,240px),1fr))', gap: 14 }}>
            {items.map((d) => <Tile key={d.id} d={d} />)}
          </div>
        </Section>
      ))}
      {!q && !domains.some((d) => d.group === 'custom') && (
        <Section title="Your categories" blurb="Anything else you want to keep track of" ink={groupOf('custom').ink}>
          <button className="card bare" onClick={() => setCreating(true)} style={{ padding: '20px 22px', border: '1.5px dashed var(--color-neutral-400)', background: 'transparent', maxWidth: 360, textAlign: 'left' }}>
            <div className="card-title">Make your own category</div>
            <div className="card-body">Wine cellar, plant care, recipes, gear… with the details you choose.</div>
          </button>
        </Section>
      )}
      {creating && <NewCategory onClose={() => setCreating(false)} onDone={(id) => { setCreating(false); reload(); nav(`/admin/life/${id}`); }} />}
    </div>
  );
}

function Tile({ d }: { d: Domain }) {
  const g = groupOf(d.group);
  const empty = d.count === 0;
  return (
    <Link to={`/admin/life/${d.id}`} className="card" style={{ padding: '18px 20px', gap: 10, textDecoration: 'none', color: 'inherit', minHeight: 132, background: empty ? 'transparent' : 'var(--color-surface)', border: empty ? '1.5px dashed var(--color-neutral-300)' : '1.5px solid transparent', transition: 'transform .15s' }}
      onMouseEnter={(e) => (e.currentTarget.style.transform = 'translateY(-2px)')} onMouseLeave={(e) => (e.currentTarget.style.transform = '')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Mono d={d} size={38} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-heading)', fontSize: 17, lineHeight: 1.15, display: 'flex', alignItems: 'center', gap: 6 }}>
            {d.label}{d.sensitivity === 'secret' && <Lock style={{ color: 'var(--color-accent-700)' }} />}
          </div>
          <div className="text-muted" style={{ fontSize: 12 }}>{empty ? 'Not started' : `${d.count} ${d.count === 1 ? d.noun : plural(d.noun)}${d.currentCount && d.currentCount !== d.count ? ` · ${d.currentCount} current` : ''}`}</div>
        </div>
      </div>
      <div style={{ fontSize: 13, color: empty ? 'var(--color-neutral-600)' : 'var(--color-text)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
        {empty ? d.description : d.preview?.[0]}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 'auto' }}>
        {d.sharedWith > 0 && <span className="tag tag-accent-2">Shared with {d.sharedWith}</span>}
        {d.feeds.length > 0 && <span className="tag tag-neutral">Feeds your profile</span>}
        {empty && <span style={{ fontSize: 12, color: g.ink, fontWeight: 600 }}>Add {/^[aeiou]/i.test(d.noun) ? 'an' : 'a'} {d.noun} →</span>}
      </div>
    </Link>
  );
}

export const plural = (n: string) => (/(s|x|ch|sh)$/.test(n) ? `${n}es` : /[^aeiou]y$/.test(n) ? `${n.slice(0, -1)}ies` : /^(ID)$/.test(n) ? 'IDs' : `${n}s`);

/** Decorative dots that hint at a line of life events. */
function TimelineSpark({ n }: { n: number }) {
  const dots = Math.min(Math.max(n, 3), 12);
  return (
    <div aria-hidden style={{ position: 'relative', height: 16, marginTop: 4 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 7, height: 2, background: 'var(--color-accent-2-300)', borderRadius: 2 }} />
      {Array.from({ length: dots }, (_, i) => (
        <span key={i} style={{ position: 'absolute', top: 3, left: `${(i / (dots - 1)) * 96}%`, width: 10, height: 10, borderRadius: '50%', background: i < n ? 'var(--color-accent-2-600)' : 'var(--color-accent-2-200)', border: '2px solid var(--color-accent-2-100)' }} />
      ))}
    </div>
  );
}

const TYPES: [string, string][] = [['text', 'Text'], ['longtext', 'Paragraph'], ['date', 'Date'], ['datetime', 'Date and time'], ['number', 'Number'], ['money', 'Money'], ['boolean', 'Yes / no'], ['email', 'Email'], ['phone', 'Phone'], ['url', 'Link'], ['country', 'Country'], ['contact', 'Contact']];

function NewCategory({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const { run, busy } = useAction();
  const [label, setLabel] = useState('');
  const [dated, setDated] = useState(false);
  const [sensitivity, setSensitivity] = useState<'standard' | 'sensitive' | 'secret'>('sensitive');
  const [parts, setParts] = useState([{ label: '', type: 'text', required: true }, { label: '', type: 'text', required: false }]);
  const create = async () => {
    const r = await run(() => post<{ id: string }>('/api/v1/catalog', { label, dated, sensitivity, parts: parts.filter((p) => p.label.trim()).map((p) => ({ ...p, key: p.label })) }), `${label} created`);
    if (r) onDone(r.id);
  };
  return (
    <Dialog title="New category" onClose={onClose} width={560} actions={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !label.trim() || !parts.some((p) => p.label.trim())} onClick={create}>Create category</button>
    </>}>
      <div className="field"><label htmlFor="cl">Name</label><input id="cl" className="input" placeholder="Wine cellar" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
      <div className="field"><label>Details to keep</label>
        <div style={{ display: 'grid', gap: 8 }}>
          {parts.map((p, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: 8 }}>
              <input className="input" aria-label={`Detail ${i + 1}`} placeholder={i === 0 ? 'Wine' : 'Vintage'} value={p.label} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <Select value={p.type} onChange={(v) => setParts(parts.map((x, j) => (j === i ? { ...x, type: v || 'text' } : x)))} options={TYPES} placeholder="Type" />
            </div>
          ))}
          <button className="btn btn-ghost" style={{ justifySelf: 'start', fontSize: 13 }} onClick={() => setParts([...parts, { label: '', type: 'text', required: false }])}>Add a detail</button>
        </div>
      </div>
      <div className="field"><label>Sensitivity</label><Pills value={sensitivity} options={[['standard', 'Standard'], ['sensitive', 'Sensitive'], ['secret', 'Secret']]} onChange={setSensitivity} /></div>
      <button role="checkbox" aria-checked={dated} className="bare" onClick={() => setDated(!dated)} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
        <span style={{ width: 18, height: 18, borderRadius: 6, border: '2px solid var(--color-accent)', background: dated ? 'var(--color-accent)' : 'transparent', color: 'var(--color-bg)', display: 'grid', placeItems: 'center', fontSize: 11 }}>{dated ? '✓' : ''}</span>
        Entries have dates (from / to)
      </button>
    </Dialog>
  );
}
