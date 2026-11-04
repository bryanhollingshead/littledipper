import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ago, get, post } from '../../api';
import { ErrorNote, Loading, Pills, useAction, useAsync } from '../../ui';
import { useAdmin } from './Layout';

type Change = { key: string; label: string; secret: boolean; to: unknown; from?: unknown };
type Item = {
  id: string; by: string; domain: string; domainLabel: string; recordId: string | null; recordTitle: string | null; recordGone: boolean;
  action: 'create' | 'update'; reason: 'suggest' | 'secret'; status: 'pending' | 'approved' | 'rejected'; createdAt: string; decidedAt: string | null;
  resultId: string | null; changes: Change[];
};

/** A part value as one line: money, dates with a zone, lists. */
function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'row' : 'rows'}`;
  if (typeof v === 'object') {
    const o = v as { amount?: number; currency?: string; at?: string };
    if (o.amount !== undefined) return `${o.amount} ${String(o.currency || '').toUpperCase()}`;
    if (o.at) return o.at.replace('T', ' ').slice(0, 16);
    return JSON.stringify(v);
  }
  return String(v);
}

export default function Review() {
  const { refresh } = useAdmin();
  const { run, busy } = useAction();
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const { data, error, reload } = useAsync(() => get<{ items: Item[] }>(`/api/reviews?status=${status}`), [status]);
  if (error) return <ErrorNote error={error} />;

  const decide = async (it: Item, verb: 'approve' | 'reject') => {
    if (await run(() => post(`/api/reviews/${it.id}/${verb}`), verb === 'approve' ? 'Approved and saved' : 'Turned down')) { reload(); refresh(); }
  };

  return (
    <div data-screen-label="Review" style={{ maxWidth: 860 }}>
      <h1>Review</h1>
      <p className="text-muted" style={{ marginTop: 0, maxWidth: 620 }}>
        Changes your assistants suggested. Nothing here is saved until you approve it. Secret details, like ID numbers, always wait here, whatever the assistant is allowed to do.
      </p>
      <Pills value={status} onChange={setStatus} options={[['pending', 'Waiting'], ['all', 'Everything']]} style={{ margin: '18px 0' }} />
      {!data ? <Loading /> : !data.items.length ? (
        <div className="card" style={{ padding: '28px 24px', textAlign: 'center' }}>
          <div style={{ fontWeight: 600 }}>{status === 'pending' ? 'Nothing waiting for you' : 'No suggestions yet'}</div>
          <div className="text-muted" style={{ fontSize: 14 }}>When an assistant suggests a change, it shows up here. Choose what each assistant may do in <Link to="/admin/apps">Apps and access</Link>.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {data.items.map((it) => (
            <div key={it.id} className="card" style={{ padding: '18px 22px', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {it.by} suggests {it.action === 'create' ? `a new entry in ${it.domainLabel}` : <>a change to {it.recordTitle ?? 'an entry'} <span className="text-muted" style={{ fontWeight: 400 }}>({it.domainLabel})</span></>}
                  </div>
                  <div className="text-muted" style={{ fontSize: 12 }}>
                    {ago(it.createdAt)}{it.reason === 'secret' ? ' · secret details always wait for you' : ''}
                  </div>
                </div>
                {it.status !== 'pending' && <span className={`tag ${it.status === 'approved' ? 'tag-accent-2' : 'tag-neutral'}`}>{it.status === 'approved' ? 'Approved' : 'Turned down'}</span>}
              </div>
              <table className="table" style={{ fontSize: 14 }}>
                <thead><tr><th>Field</th>{it.action === 'update' && <th>Now</th>}<th>{it.action === 'update' ? 'Suggested' : 'Value'}</th></tr></thead>
                <tbody>
                  {it.changes.map((c) => (
                    <tr key={c.key}>
                      <td>{c.label}{c.secret && <span className="tag tag-accent" style={{ marginLeft: 6, fontSize: 11 }}>Secret</span>}</td>
                      {it.action === 'update' && <td className="text-muted">{show(c.from)}</td>}
                      <td style={{ fontWeight: 500 }}>{show(c.to)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {it.recordGone && it.status === 'pending' && <div className="text-muted" style={{ fontSize: 13 }}>That entry was deleted since, so this can only be turned down.</div>}
              {it.status === 'pending' && (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary" disabled={busy || it.recordGone} onClick={() => decide(it, 'approve')}>Approve</button>
                  <button className="btn btn-secondary" disabled={busy} onClick={() => decide(it, 'reject')}>Turn down</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
