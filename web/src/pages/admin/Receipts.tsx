import { useMemo, useState, type DragEvent } from 'react';
import { FILE_ACCEPT, get, post, saveFile, uploadFile, type FileRef } from '../../api';
import { ErrorNote, Loading, Pills, useAsync, useToast } from '../../ui';
import { fetchCatalog, fmtDate, money, Mono, RecordEditor, useContactsLite, type Rec } from '../../life';

type Money = { amount: number; currency: string };
const DOMAIN = 'receipts';

const today = () => new Date().toISOString().slice(0, 10);
const needsDetails = (r: Rec) => !r.data.merchant || !r.data.total;
const yearOf = (r: Rec) => String(r.data.purchased ?? '').slice(0, 4);

/** Totals per currency: receipts from a trip abroad don't get added to dollars. */
function totals(recs: Rec[]): Money[] {
  const by = new Map<string, number>();
  for (const r of recs) { const t = r.data.total as Money | undefined; if (t) by.set(t.currency, (by.get(t.currency) ?? 0) + t.amount); }
  return [...by].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);
}

/** A return window or warranty ending in the next 30 days. */
function deadline(r: Rec): { label: string; date: string } | null {
  const soon = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
  for (const [k, label] of [['returnBy', 'Return by'], ['warrantyUntil', 'Warranty ends']] as const) {
    const v = r.data[k] as string | undefined;
    if (v && v.length === 10 && v >= today() && v <= soon) return { label, date: v };
  }
  return null;
}

const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export default function Receipts() {
  const toast = useToast();
  const contacts = useContactsLite();
  const { data: catalog } = useAsync(fetchCatalog, []);
  const { data, error, reload } = useAsync(() => get<{ items: Rec[] }>(`/api/v1/${DOMAIN}`), []);
  const [editing, setEditing] = useState<Rec | 'new' | null>(null);
  const [year, setYear] = useState('all');
  const [q, setQ] = useState('');
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);

  const d = catalog?.find((x) => x.id === DOMAIN);
  const all = data?.items ?? [];
  const years = useMemo(() => [...new Set(all.map(yearOf).filter(Boolean))].sort().reverse(), [all]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((r) => (year === 'all' || yearOf(r) === year) && (!needle || JSON.stringify(r.data).toLowerCase().includes(needle) || r.notes.toLowerCase().includes(needle)));
  }, [all, year, q]);
  const incomplete = shown.filter(needsDetails);
  const complete = shown.filter((r) => !needsDetails(r));
  const sums = totals(complete);
  const byCategory = useMemo(() => {
    const opts = d?.parts.find((p) => p.key === 'category')?.options ?? [];
    const main = sums[0]?.currency;
    const m = new Map<string, number>();
    for (const r of complete) { const t = r.data.total as Money | undefined; if (t && t.currency === main) { const c = String(r.data.category ?? ''); m.set(c, (m.get(c) ?? 0) + t.amount); } }
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, amount]) => ({ label: opts.find(([o]) => o === k)?.[1] ?? 'Uncategorised', amount, currency: main! }));
  }, [complete, sums, d]);

  if (error) return <ErrorNote error={error} />;
  if (!d || !data) return <Loading />;

  /** Each photo or PDF becomes its own receipt, ready for details. One upload opens straight in the editor. */
  const upload = async (files: File[]) => {
    if (!files.length) return;
    setUploading(files.length);
    const made: Rec[] = [];
    for (const f of files) {
      try {
        const ref: FileRef = await uploadFile(DOMAIN, f);
        made.push(await post<Rec>(`/api/v1/${DOMAIN}`, { data: { files: [ref.id], capturedVia: 'upload' } }));
      } catch (e) { toast(`${f.name}: ${(e as Error).message}`); }
      setUploading((n) => n - 1);
    }
    reload();
    if (made.length === 1) setEditing(made[0]);
    else if (made.length > 1) toast(`${made.length} receipts added · fill in the details when you have a moment`);
  };

  const onDrop = (e: DragEvent) => { e.preventDefault(); setDragging(false); upload(Array.from(e.dataTransfer.files)); };

  const exportCsv = () => {
    const head = ['Date', 'Merchant', 'Category', 'Total', 'Currency', 'Subtotal', 'Tax', 'Paid with', 'Order number', 'Return by', 'Warranty until', 'Items', 'Notes'];
    const lines = shown.map((r) => {
      const v = r.data, t = v.total as Money | undefined;
      const items = ((v.items as { description: string; quantity?: number }[] | undefined) ?? []).map((i) => (i.quantity ? `${i.quantity} × ${i.description}` : i.description)).join('; ');
      return [v.purchased, v.merchant, v.category, t?.amount, t?.currency, (v.subtotal as Money | undefined)?.amount, (v.tax as Money | undefined)?.amount, v.paymentMethod, v.orderNumber, v.returnBy, v.warrantyUntil, items, r.notes].map(csvCell).join(',');
    });
    saveFile(`receipts-${year === 'all' ? 'all' : year}.csv`, [head.join(','), ...lines].join('\n') + '\n', 'text/csv');
  };

  return (
    <div data-screen-label="Receipts" style={{ maxWidth: 1040, position: 'relative' }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }} onDrop={onDrop}>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <Mono d={d} size={64} />
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="card-kicker">Money</div>
          <h1 style={{ margin: 0 }}>Receipts</h1>
          <p className="text-muted" style={{ margin: '4px 0 0', maxWidth: 600 }}>Snap or drop a receipt and it’s kept. Add the details now or later, for taxes, returns, warranties and buying again.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={() => setEditing('new')}>Type one in</button>
          <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
            {uploading ? `Uploading ${uploading}…` : 'Upload receipts'}
            <input type="file" accept={FILE_ACCEPT} multiple hidden onChange={(e) => { upload(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          </label>
        </div>
      </div>

      {dragging && (
        <div style={{ position: 'absolute', inset: -12, zIndex: 5, borderRadius: 32, border: '2px dashed var(--color-accent-500)', background: 'color-mix(in srgb, var(--color-accent-100) 85%, transparent)', display: 'grid', placeItems: 'center', fontFamily: 'var(--font-heading)', fontSize: 22, pointerEvents: 'none' }}>
          Drop to add receipts
        </div>
      )}

      {all.length === 0 ? (
        <div className="card" style={{ marginTop: 24, padding: '34px 30px', gap: 10, alignItems: 'flex-start', background: 'var(--color-neutral-200)' }}>
          <div className="card-title" style={{ fontSize: 22 }}>No receipts yet</div>
          <div style={{ fontSize: 14, maxWidth: 540 }}>Upload a photo or PDF, or drag one onto this page. Each becomes a receipt you can fill in. Return-by and warranty dates show up on Home before they pass.</div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', margin: '22px 0 0' }}>
            <Pills value={year} options={[['all', 'All years'], ...years.map((y) => [y, y] as [string, string])]} onChange={setYear} size={12} />
            <input className="input" type="search" placeholder="Search merchant, item, notes…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 200px', maxWidth: 320 }} />
            <span style={{ flex: 1 }} />
            <button className="btn btn-ghost" style={{ fontSize: 13 }} onClick={exportCsv} disabled={!shown.length}>Download CSV</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginTop: 16 }}>
            <div className="card" style={{ padding: '18px 20px', gap: 4 }}>
              <div className="card-kicker">{year === 'all' ? 'Spent, all time' : `Spent in ${year}`}</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 26 }}>{sums.length ? money(sums[0]) : '—'}</div>
              <div className="text-muted" style={{ fontSize: 12 }}>{complete.length} receipt{complete.length === 1 ? '' : 's'}{sums.length > 1 ? ` · plus ${sums.slice(1).map(money).join(', ')}` : ''}</div>
            </div>
            {byCategory.length > 0 && (
              <div className="card" style={{ padding: '18px 20px', gap: 6 }}>
                <div className="card-kicker">By category</div>
                {byCategory.map((c) => (
                  <div key={c.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}><span>{c.label}</span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{money({ amount: Math.round(c.amount * 100) / 100, currency: c.currency })}</span></div>
                ))}
              </div>
            )}
          </div>

          {incomplete.length > 0 && (
            <section style={{ marginTop: 26 }}>
              <h4 style={{ marginBottom: 4 }}>Needs details · {incomplete.length}</h4>
              <p className="text-muted" style={{ fontSize: 13, margin: '0 0 10px' }}>Kept safe, but missing the merchant or total. Once you connect an assistant, it can read these for you.</p>
              <div style={{ display: 'grid', gap: 8 }}>{incomplete.map((r) => <Row key={r.id} r={r} onOpen={() => setEditing(r)} />)}</div>
            </section>
          )}

          <section style={{ marginTop: 26 }}>
            {incomplete.length > 0 && <h4 style={{ marginBottom: 10 }}>Receipts</h4>}
            {complete.length === 0 ? <p className="text-muted" style={{ fontSize: 14 }}>{q || year !== 'all' ? 'Nothing matches.' : 'None with details yet.'}</p> : (
              <div style={{ display: 'grid', gap: 8 }}>{complete.map((r) => <Row key={r.id} r={r} catLabel={d.parts.find((p) => p.key === 'category')?.options} onOpen={() => setEditing(r)} />)}</div>
            )}
          </section>
        </>
      )}

      {editing && (
        <RecordEditor d={d} rec={editing === 'new' ? null : editing} contacts={contacts} onClose={() => { setEditing(null); reload(); }} onSaved={() => { setEditing(null); reload(); }}
          defaults={editing === 'new' ? { purchased: today(), capturedVia: 'manual' } : undefined} />
      )}
    </div>
  );
}

function Row({ r, onOpen, catLabel }: { r: Rec; onOpen: () => void; catLabel?: [string, string][] }) {
  const files = (r.data.files as FileRef[] | undefined) ?? [];
  const items = (r.data.items as unknown[] | undefined)?.length ?? 0;
  const due = deadline(r);
  const cat = catLabel?.find(([k]) => k === r.data.category)?.[1];
  const sub = [cat, items ? `${items} item${items === 1 ? '' : 's'}` : '', files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ');
  return (
    <button className="bare card receipt-row" onClick={onOpen} style={{ padding: '12px 18px', gap: 14 }}>
      <span className="text-muted" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{r.data.purchased ? fmtDate(String(r.data.purchased)) : 'No date'}</span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(r.data.merchant || (files[0]?.name ?? 'Receipt'))}</span>
        {sub && <span className="text-muted" style={{ display: 'block', fontSize: 12 }}>{sub}</span>}
      </span>
      <span className="receipt-tags">{due && <span className="tag tag-accent">{due.label} {fmtDate(due.date)}</span>}{needsDetails(r) && <span className="tag tag-neutral">Needs details</span>}</span>
      <span style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{r.data.total ? money(r.data.total as Money) : '—'}</span>
    </button>
  );
}
