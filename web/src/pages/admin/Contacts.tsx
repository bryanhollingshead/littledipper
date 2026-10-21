import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ago, get, initials, post, STATUS, type Contact } from '../../api';
import { ErrorNote, Loading, Pills, useAction, useAsync } from '../../ui';
import { useAdmin } from './Layout';
import AddContact from './AddContact';

type Req = { _id: string; contactId: string; peerName: string; fromNode: string; requestedFields: string[]; inviteId: string | null; quiet: boolean };

export const shareSummary = (c: Contact) => {
  if (c.kind !== 'node') return '—';
  if (c.status === 'pending_in') return 'Not yet';
  const n = c.grants.fields.length;
  return c.grants.profile ? (n ? `Basic profile + ${n}` : 'Basic profile') : n ? `${n} field${n === 1 ? '' : 's'} only` : 'Nothing';
};

export default function Contacts() {
  const nav = useNavigate();
  const { refresh } = useAdmin();
  const { run } = useAction();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'node' | 'person'>('all');
  const [modal, setModal] = useState<null | 'person' | 'invite'>(null);
  const { data, error, reload } = useAsync(() => get<{ items: Contact[] }>('/api/v1/contacts'), []);
  const { data: reqs, reload: reloadReqs } = useAsync(() => get<{ items: Req[] }>('/api/v1/federation/requests?status=pending&direction=in'), []);

  if (error) return <ErrorNote error={error} />;
  const term = q.toLowerCase();
  const rows = (data?.items || []).filter((c) => (filter === 'all' || c.kind === filter) && (!term || c.displayName.toLowerCase().includes(term) || (c.org || '').toLowerCase().includes(term)));

  const decline = async (r: Req) => {
    if (await run(() => post(`/api/v1/federation/requests/${r._id}/decline`), 'Request declined')) {
      reload(); reloadReqs(); refresh();
    }
  };

  return (
    <div data-screen-label="Contacts" style={{ maxWidth: 1040 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>Contacts</h1><p className="text-muted" style={{ margin: 0 }}>People who also run Little Dipper can connect with you securely. You choose exactly what each of them can see.</p></div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setModal('invite')}>Invite link</button>
          <button className="btn btn-primary" onClick={() => setModal('person')}>Add contact</button>
        </div>
      </div>

      {reqs?.items.map((r) => (
        <div key={r._id} style={{ marginTop: 22, borderRadius: 32, background: r.quiet ? 'var(--color-neutral-100)' : 'var(--color-accent-100)', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--color-accent-300)', display: 'grid', placeItems: 'center', fontSize: 13, flex: 'none' }}>{initials(r.peerName)}</span>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 600 }}>{r.peerName} wants to connect</div>
            <div style={{ fontSize: 13, color: 'var(--color-accent-800)' }}>
              <span className="mono">{r.fromNode}</span>
              {r.requestedFields.length > 0 && ` · asks for ${r.requestedFields.length} field${r.requestedFields.length === 1 ? '' : 's'}`}
              {r.inviteId ? ' · used your invite link' : r.quiet ? ' · not connected to anyone you know' : ''} · identity confirmed
            </div>
          </div>
          <button className="btn btn-secondary" onClick={() => decline(r)}>Decline</button>
          <button className="btn btn-primary" onClick={() => nav(`/admin/contacts/${r.contactId}`)}>Review request</button>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '24px 0 12px', flexWrap: 'wrap' }}>
        <input className="input" aria-label="Search contacts" placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} />
        <Pills value={filter} options={[['all', 'All'], ['node', 'On Little Dipper'], ['person', 'People']]} onChange={setFilter} />
      </div>
      {!data ? <Loading /> : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Name</th><th>Type</th><th>Status</th><th>You share</th><th>Last activity</th></tr></thead>
            <tbody>
              {rows.map((c) => {
                const sub = c.node ? c.node.url : c.org || c.methods[0]?.value || '';
                return (
                  <tr key={c.id} className="row-btn" tabIndex={0} onClick={() => nav(`/admin/contacts/${c.id}`)} onKeyDown={(e) => e.key === 'Enter' && nav(`/admin/contacts/${c.id}`)}>
                    <td><div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ width: 34, height: 34, borderRadius: '50%', background: c.kind === 'node' ? 'var(--color-accent-2-200)' : 'var(--color-accent-200)', display: 'grid', placeItems: 'center', fontSize: 12, flex: 'none' }}>{initials(c.displayName)}</span>
                      <div><div style={{ fontWeight: 600 }}>{c.displayName}</div><div className="text-muted" style={{ fontSize: 12, fontFamily: c.node ? 'var(--mono)' : 'inherit' }}>{sub}</div></div>
                    </div></td>
                    <td><span className={`tag ${c.kind === 'node' ? 'tag-accent-2' : 'tag-neutral'}`}>{c.kind === 'node' ? 'Little Dipper' : 'Person'}</span></td>
                    <td><span className={`tag ${STATUS[c.status][1]}`}>{STATUS[c.status][0]}</span></td>
                    <td style={{ fontSize: 13 }}>{shareSummary(c)}</td>
                    <td className="text-muted" style={{ fontSize: 13 }}>{c.lastActivity.text} · {ago(c.lastActivity.at)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={5} className="text-muted" style={{ fontSize: 14, padding: '18px 8px' }}>{data.items.length ? 'No contacts match.' : 'No contacts yet. Add someone, or send an invite link.'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {modal && <AddContact initialTab={modal} onClose={() => setModal(null)} onDone={(id) => { setModal(null); reload(); if (id) nav(`/admin/contacts/${id}`); }} />}
    </div>
  );
}
