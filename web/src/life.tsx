/** Shared pieces for the "My life" area: catalog types, group styling, dates, and the schema-driven record editor. */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { del, get, patch, post, type Sensitivity } from './api';
import { Confirm, Pills, Toggle, useAction, type ConfirmCfg } from './ui';

// ── types ──────────────────────────────────────────────────────────────
export type Part = { key: string; label: string; type: string; required?: boolean; sensitivity: Sensitivity; options?: [string, string][]; hint?: string };
export type Domain = {
  id: string; label: string; noun: string; group: string; description: string; sensitivity: Sensitivity; dated: boolean; builtIn: boolean;
  parts: Part[]; title: string; count: number; currentCount: number; preview: string[]; sharedWith: number; feeds: string[];
};
export type Rec = {
  id: string; domain: string; title: string; data: Record<string, unknown>; masked: string[]; validFrom: string | null; validTo: string | null;
  current: boolean; notes: string; createdAt: string; updatedAt: string;
};
export type ContactLite = { id: string; displayName: string };

export const fetchCatalog = () => get<{ domains: Domain[] }>('/api/v1/catalog').then((r) => r.domains);

// ── groups ─────────────────────────────────────────────────────────────
export type Group = { id: string; label: string; blurb: string; ink: string; wash: string };
export const GROUPS: Group[] = [
  { id: 'identity', label: 'Identity', blurb: 'Who you are, on paper', ink: 'var(--color-accent-700)', wash: 'var(--color-accent-100)' },
  { id: 'life', label: 'Life', blurb: 'Where you live, who you live with, where you’ve been', ink: 'var(--color-accent-2-600)', wash: 'var(--color-accent-2-100)' },
  { id: 'work', label: 'Work', blurb: 'What you do and what you’ve learned', ink: 'var(--color-accent-500)', wash: 'var(--color-accent-200)' },
  { id: 'health', label: 'Health', blurb: 'Your body, your care, your cover', ink: 'var(--color-accent-2-800)', wash: 'var(--color-accent-2-200)' },
  { id: 'money', label: 'Money', blurb: 'Accounts, income, taxes and your estate', ink: 'var(--color-neutral-800)', wash: 'var(--color-neutral-200)' },
  { id: 'things', label: 'Things', blurb: 'What you own and what you belong to', ink: 'var(--color-accent-600)', wash: 'var(--color-accent-100)' },
  { id: 'personal', label: 'Personal', blurb: 'The details that make you you', ink: 'var(--color-accent-2-500)', wash: 'var(--color-accent-2-100)' },
  { id: 'custom', label: 'Your categories', blurb: 'Anything else you want to keep track of', ink: 'var(--color-neutral-600)', wash: 'var(--color-neutral-200)' },
];
export const groupOf = (id: string) => GROUPS.find((g) => g.id === id) ?? GROUPS[GROUPS.length - 1];

/** Two-letter monogram in the category's group colours. */
export function Mono({ d, size = 40 }: { d: Pick<Domain, 'label' | 'group'>; size?: number }) {
  const g = groupOf(d.group);
  const letters = d.label.replace(/&/g, '').split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <span aria-hidden style={{ width: size, height: size, borderRadius: size > 48 ? 22 : 14, background: g.wash, color: g.ink, display: 'grid', placeItems: 'center', fontFamily: 'var(--font-heading)', fontSize: size * 0.38, flex: 'none' }}>{letters}</span>
  );
}

export const Lock = ({ style }: { style?: CSSProperties }) => (
  <svg aria-label="Secret" role="img" width="11" height="12" viewBox="0 0 11 12" style={{ flex: 'none', ...style }}>
    <rect x="1" y="5" width="9" height="6.5" rx="2" fill="currentColor" />
    <path d="M3 5V3.6a2.5 2.5 0 0 1 5 0V5" stroke="currentColor" strokeWidth="1.4" fill="none" />
  </svg>
);

// ── dates ──────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(v: string | null | undefined) {
  if (!v) return '';
  const [y, m, d] = v.split('-');
  if (!m) return y;
  if (!d) return `${MONTHS[+m - 1]} ${y}`;
  return `${+d} ${MONTHS[+m - 1]} ${y}`;
}
export function fmtRange(from: string | null, to: string | null) {
  if (!from && !to) return '';
  if (!from) return `Until ${fmtDate(to)}`;
  return `${fmtDate(from)} – ${to ? fmtDate(to) : 'present'}`;
}
/** "3 yrs 4 mos" between two partial dates (to = now when open). */
export function duration(from: string | null, to: string | null) {
  if (!from) return '';
  const a = new Date(from.length === 4 ? `${from}-01-01` : from.length === 7 ? `${from}-01` : from);
  const b = to ? new Date(to.length === 4 ? `${to}-12-31` : to.length === 7 ? `${to}-28` : to) : new Date();
  const months = Math.max(0, (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth());
  const y = Math.floor(months / 12), m = months % 12;
  return [y ? `${y} yr${y === 1 ? '' : 's'}` : '', m ? `${m} mo${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ') || 'under a month';
}

// ── countries ──────────────────────────────────────────────────────────
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ', 'AC', 'CP', 'DG', 'EA', 'IC', 'TA', 'CQ']);
let countryCache: [string, string][] | null = null;
export function countries(): [string, string][] {
  if (countryCache) return countryCache;
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const out: [string, string][] = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    if (NOT_COUNTRIES.has(code)) continue;
    try { const n = names.of(code); if (n && n !== code && !/unknown/i.test(n)) out.push([code, n]); } catch { /* not a region */ }
  }
  return (countryCache = out.sort((x, y) => x[1].localeCompare(y[1])));
}
export const countryName = (code: string) => countries().find(([c]) => c === code)?.[1] ?? code;

/** Human value for display. */
export function show(p: Part, v: unknown, contacts: ContactLite[]): string {
  if (v === undefined || v === null || v === '') return '';
  switch (p.type) {
    case 'enum': return p.options?.find(([k]) => k === v)?.[1] ?? String(v);
    case 'country': return countryName(String(v));
    case 'money': { const m = v as { amount: number; currency: string }; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: m.currency, maximumFractionDigits: 0 }).format(m.amount); } catch { return `${m.amount} ${m.currency}`; } }
    case 'boolean': return v ? 'Yes' : 'No';
    case 'date': return fmtDate(String(v));
    case 'contact': return contacts.find((c) => c.id === v)?.displayName ?? 'Removed contact';
    case 'last4': return `•••• ${v}`;
    case 'url': return String(v).replace(/^https?:\/\//, '').replace(/\/$/, '');
    default: return String(v);
  }
}

// ── inputs ─────────────────────────────────────────────────────────────
const selectStyle: CSSProperties = { appearance: 'none', backgroundImage: 'linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%)', backgroundPosition: 'calc(100% - 18px) 55%, calc(100% - 13px) 55%', backgroundSize: '5px 5px', backgroundRepeat: 'no-repeat', paddingRight: 32 };
export function Select({ value, onChange, options, placeholder, id, style }: { value: string; onChange: (v: string) => void; options: [string, string][]; placeholder?: string; id?: string; style?: CSSProperties }) {
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} style={{ ...selectStyle, ...style }}>
      <option value="">{placeholder ?? '—'}</option>
      {options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>
  );
}

/** Year, then optionally month and day: histories rarely know the exact day. */
export function PartialDate({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  const [y = '', m = '', d = ''] = value ? value.split('-') : [];
  const set = (ny: string, nm: string, nd: string) => onChange(!ny ? '' : [ny, nm, nm ? nd : ''].filter(Boolean).join('-'));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 80px', gap: 6 }}>
      <input id={id} className="input mono" inputMode="numeric" placeholder="Year" maxLength={4} value={y} onChange={(e) => set(e.target.value.replace(/\D/g, ''), m, d)} />
      <Select value={m} onChange={(v) => set(y, v, d)} placeholder="Month" options={MONTHS.map((n, i) => [String(i + 1).padStart(2, '0'), n])} />
      <Select value={d} onChange={(v) => set(y, m, v)} placeholder="Day" options={Array.from({ length: 31 }, (_, i) => [String(i + 1).padStart(2, '0'), String(i + 1)])} />
    </div>
  );
}

function PartInput({ p, value, onChange, contacts, hiddenSaved }: { p: Part; value: unknown; onChange: (v: unknown) => void; contacts: ContactLite[]; hiddenSaved: boolean }) {
  const id = `part-${p.key}`;
  const ph = hiddenSaved ? 'Saved and hidden · type to replace' : p.hint || '';
  switch (p.type) {
    case 'longtext':
      return <textarea id={id} className="input" style={{ borderRadius: 20, minHeight: 80 }} placeholder={ph} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <PartialDate id={id} value={String(value ?? '')} onChange={onChange} />;
    case 'country':
      return <Select id={id} value={String(value ?? '')} onChange={onChange} options={countries()} placeholder="Choose a country" />;
    case 'enum':
      return (p.options!.length <= 4
        ? <Pills value={String(value ?? '')} options={p.options as [string, string][]} onChange={(v) => onChange(v === value ? '' : v)} size={12} />
        : <Select id={id} value={String(value ?? '')} onChange={onChange} options={p.options!} placeholder="Choose…" />);
    case 'boolean':
      return <Toggle on={!!value} label={p.label} onChange={() => onChange(!value)} />;
    case 'contact':
      return <Select id={id} value={String(value ?? '')} onChange={onChange} options={contacts.map((c) => [c.id, c.displayName])} placeholder={contacts.length ? 'Choose from your contacts' : 'No contacts yet'} />;
    case 'money': {
      const m = (value as { amount?: number | string; currency?: string } | null) ?? {};
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px', gap: 6 }}>
          <input id={id} className="input" inputMode="decimal" placeholder={hiddenSaved ? 'Saved and hidden · type to replace' : 'Amount'} value={m.amount ?? ''} onChange={(e) => onChange(e.target.value === '' ? '' : { amount: e.target.value, currency: m.currency || 'USD' })} />
          <input className="input mono" aria-label="Currency" maxLength={3} value={m.currency ?? 'USD'} onChange={(e) => onChange({ amount: m.amount ?? '', currency: e.target.value.toUpperCase() })} />
        </div>
      );
    }
    case 'last4':
      return <input id={id} className="input mono" inputMode="numeric" maxLength={4} placeholder={hiddenSaved ? '••••' : 'Last 4 digits only'} value={String(value ?? '')} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} style={{ maxWidth: 160, letterSpacing: '.2em' }} />;
    case 'number':
      return <input id={id} className="input" inputMode="numeric" placeholder={ph} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 200 }} />;
    default:
      return <input id={id} className="input" type={p.type === 'email' ? 'email' : p.type === 'phone' ? 'tel' : p.type === 'url' ? 'url' : 'text'} placeholder={ph} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
}

const titleKeys = (d: Domain) => [...d.title.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

// ── the editor: a side panel generated from the domain's schema ───────
export function RecordEditor({ d, rec, contacts, onClose, onSaved }: { d: Domain; rec: Rec | null; contacts: ContactLite[]; onClose: () => void; onSaved: () => void }) {
  const { run, busy } = useAction();
  const [vals, setVals] = useState<Record<string, unknown>>(() => {
    if (!rec) return {};
    // Secret parts arrive masked: start them blank, keep them unless replaced.
    return Object.fromEntries(Object.entries(rec.data).filter(([k]) => !rec.masked.includes(k)));
  });
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState(rec?.validFrom ?? '');
  const [to, setTo] = useState(rec?.validTo ?? '');
  const [current, setCurrent] = useState(rec ? !rec.validTo : true);
  const [notes, setNotes] = useState(rec?.notes ?? '');
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !confirm && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, confirm]);

  const tKeys = titleKeys(d);
  const essential = d.parts.filter((p, i) => p.required || tKeys.includes(p.key) || i < 4);
  const extra = d.parts.filter((p) => !essential.includes(p));
  const extraFilled = extra.some((p) => vals[p.key] !== undefined && vals[p.key] !== '' || rec?.masked.includes(p.key));

  const set = (k: string, v: unknown) => {
    setVals((s) => ({ ...s, [k]: v }));
    setTouched((t) => new Set(t).add(k));
  };

  const save = async () => {
    setError('');
    const data: Record<string, unknown> = {};
    for (const p of d.parts) {
      if (rec && !touched.has(p.key)) continue;
      let v = vals[p.key];
      if (p.type === 'money' && v && typeof v === 'object') {
        const m = v as { amount: string | number; currency: string };
        v = m.amount === '' || m.amount === undefined ? null : { amount: Number(m.amount), currency: m.currency || 'USD' };
      }
      if (p.type === 'number' && v !== '' && v !== undefined) v = Number(v);
      data[p.key] = v === '' || v === undefined ? (rec ? null : undefined) : v;
      if (data[p.key] === undefined) delete data[p.key];
    }
    const body = { data, notes, ...(d.dated ? { validFrom: from || null, validTo: current ? null : to || null } : {}) };
    try {
      if (rec) await patch(`/api/v1/${d.id}/${rec.id}`, body);
      else await post(`/api/v1/${d.id}`, body);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = () => setConfirm({
    title: `Delete this ${d.noun}?`, body: `${rec!.title} is removed from your Little Dipper and from anyone you share ${d.label} with.`, cta: 'Delete',
    onConfirm: async () => { if (await run(() => del(`/api/v1/${d.id}/${rec!.id}`))) onSaved(); },
  });

  const field = (p: Part) => (
    <div key={p.key} className="field">
      <label htmlFor={`part-${p.key}`} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {p.label}{p.required && <span aria-hidden style={{ color: 'var(--color-accent-500)' }}>*</span>}
        {p.sensitivity === 'secret' && <span className="tag tag-accent" style={{ padding: '1px 8px', fontSize: 10, gap: 4 }}><Lock style={{ width: 8, height: 9 }} />Secret</span>}
      </label>
      <PartInput p={p} value={vals[p.key]} onChange={(v) => set(p.key, v)} contacts={contacts} hiddenSaved={!!rec?.masked.includes(p.key) && !touched.has(p.key)} />
    </div>
  );

  return (
    <div className="dialog-backdrop" style={{ zIndex: 50, placeItems: 'stretch end', padding: 0 }} onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label={rec ? `Edit ${d.noun}` : `Add ${d.noun}`} onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(540px, 100%)', height: '100%', background: 'var(--color-bg)', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', borderRadius: '32px 0 0 32px' }}>
        <div style={{ padding: '26px 28px 16px', display: 'flex', gap: 14, alignItems: 'center' }}>
          <Mono d={d} size={44} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="card-kicker" style={{ color: groupOf(d.group).ink }}>{d.label}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, lineHeight: 1.15 }}>{rec ? rec.title : `New ${d.noun}`}</div>
          </div>
          <button className="btn btn-secondary" onClick={onClose} aria-label="Close" style={{ width: 36, height: 36, padding: 0 }}>×</button>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save(); }} style={{ flex: 1, overflow: 'auto', padding: '4px 28px 24px', display: 'grid', gap: 14, alignContent: 'start' }}>
          {essential.map(field)}
          {d.dated && (
            <div className="card" style={{ padding: '16px 18px', gap: 10, background: 'var(--color-neutral-100)' }}>
              <div className="field"><label htmlFor="vf">From</label><PartialDate id="vf" value={from} onChange={setFrom} /></div>
              <button type="button" role="checkbox" aria-checked={current} className="bare" onClick={() => setCurrent(!current)} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                <span style={{ width: 18, height: 18, borderRadius: 6, border: '2px solid var(--color-accent)', background: current ? 'var(--color-accent)' : 'transparent', color: 'var(--color-bg)', display: 'grid', placeItems: 'center', fontSize: 11 }}>{current ? '✓' : ''}</span>
                This is current
              </button>
              {!current && <div className="field"><label htmlFor="vt">To</label><PartialDate id="vt" value={to} onChange={setTo} /></div>}
            </div>
          )}
          {extra.length > 0 && (
            <>
              <button type="button" className="btn btn-ghost" style={{ justifySelf: 'start', fontSize: 13 }} onClick={() => setMore(!more)}>
                {more || extraFilled ? 'Fewer details' : `More details · ${extra.length}`}
              </button>
              {(more || extraFilled) && extra.map(field)}
            </>
          )}
          <div className="field"><label htmlFor="notes">Notes</label><textarea id="notes" className="input" style={{ borderRadius: 20, minHeight: 70 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything worth remembering" /></div>
          {error && <div style={{ color: 'var(--color-accent-700)', fontSize: 13 }}>{error}</div>}
          <button type="submit" hidden />
        </form>
        <div style={{ padding: '14px 28px 22px', display: 'flex', gap: 8, borderTop: '1px solid var(--color-divider)' }}>
          {rec && <button className="btn btn-ghost" onClick={remove} style={{ color: 'var(--color-accent-700)', marginRight: 'auto' }}>Delete</button>}
          <span style={{ flex: rec ? 0 : 1 }} />
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{rec ? 'Save' : `Add ${d.noun}`}</button>
        </div>
      </aside>
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

/** Key/value details of a record, with masked secrets. */
export function Details({ d, rec, revealed, contacts, skip = [] }: { d: Domain; rec: Rec; revealed?: Record<string, unknown>; contacts: ContactLite[]; skip?: string[] }) {
  const rows = d.parts
    .filter((p) => !skip.includes(p.key) && (rec.data[p.key] !== undefined && rec.data[p.key] !== null || rec.masked.includes(p.key)))
    .map((p) => {
      const masked = rec.masked.includes(p.key) && !revealed;
      const v = revealed ? revealed[p.key] : rec.data[p.key];
      return { p, text: masked ? '••••••' : show(p, v, contacts), masked };
    })
    .filter((r) => r.text);
  if (!rows.length) return null;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: '10px 18px', margin: '12px 0 0' }}>
      {rows.map(({ p, text, masked }) => (
        <div key={p.key} style={{ minWidth: 0 }}>
          <dt className="text-muted" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>{p.label}{p.sensitivity === 'secret' && <Lock style={{ width: 8, height: 9 }} />}</dt>
          <dd style={{ margin: 0, fontSize: 14, overflowWrap: 'anywhere', whiteSpace: p.type === 'longtext' ? 'pre-wrap' : undefined, fontFamily: masked || p.type === 'last4' ? 'var(--mono)' : undefined, color: masked ? 'var(--color-neutral-500)' : undefined }}>{text}</dd>
        </div>
      ))}
    </dl>
  );
}

export function useContactsLite() {
  const [list, setList] = useState<ContactLite[]>([]);
  useEffect(() => { get<{ items: ContactLite[] }>('/api/v1/contacts').then((r) => setList(r.items)).catch(() => {}); }, []);
  return list;
}

export function useGrouped(domains: Domain[] | null | undefined) {
  return useMemo(() => GROUPS.map((g) => ({ g, items: (domains || []).filter((d) => d.group === g.id) })).filter((x) => x.items.length), [domains]);
}

export const Section = ({ title, blurb, ink, right, children }: { title: string; blurb?: string; ink?: string; right?: ReactNode; children: ReactNode }) => (
  <section style={{ marginTop: 34 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, color: ink }}>{title}</h3>
        {blurb && <span className="text-muted" style={{ fontSize: 13 }}>{blurb}</span>}
      </div>
      {right}
    </div>
    {children}
  </section>
);
