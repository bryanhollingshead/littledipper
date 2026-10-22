import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addr, ago, firstName, get, initials, post, whenLabel, type AuditEvent } from '../../api';
import { useAction, useAsync } from '../../ui';
import { fetchCatalog, fmtDate, GROUPS } from '../../life';
import { useAdmin } from './Layout';
import AddContact from './AddContact';

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};
const TONE = { peer: 'var(--color-accent-2)', request: 'var(--color-accent)', owner: 'var(--color-neutral-500)', system: 'var(--color-neutral-500)' };

export default function Home() {
  const { owner, node, refresh } = useAdmin();
  const nav = useNavigate();
  const { run } = useAction();
  const [modal, setModal] = useState<null | 'add' | 'invite'>(null);
  const { data: reqs } = useAsync(() => get('/api/v1/federation/requests?status=pending&direction=in'), []);
  const { data: audit, reload } = useAsync(() => get<{ items: AuditEvent[] }>('/api/v1/audit?limit=6'), []);
  const { data: catalog } = useAsync(fetchCatalog, []);
  const { data: attention } = useAsync(() => get<{ items: { domain: string; id: string; title: string; part: string; kind?: 'expiry' | 'deadline'; date: string; expired: boolean }[] }>('/api/v1/attention?days=90'), []);

  const inbox = [
    ...(reqs?.items || []).filter((r: { quiet: boolean }) => !r.quiet).map((r: { _id: string; contactId: string; fromNode: string; peerName: string }) => ({
      key: r._id, initials: initials(r.peerName), title: `${r.peerName} wants to connect`, sub: r.fromNode, cta: 'Review', go: () => nav(`/admin/contacts/${r.contactId}`),
    })),
    ...(attention?.items || []).slice(0, 3).map((a) => ({
      key: a.id + a.part, initials: initials(catalog?.find((d) => d.id === a.domain)?.label.replace('&', '') || a.domain), title: a.kind === 'deadline' ? `${a.part}: ${a.title}` : `${a.title} ${a.expired ? 'has expired' : 'expires soon'}`, sub: a.kind === 'deadline' && a.expired ? `Passed ${fmtDate(a.date)}` : `${a.part} ${fmtDate(a.date)}`, cta: 'Open', go: () => nav(`/admin/life/${a.domain}`),
    })),
    ...(node.update.available ? [{ key: 'update', initials: '↑', title: `Update ${node.update.latest} is ready`, sub: 'Release notes in Settings', cta: 'View', go: () => nav('/admin/settings/hosting') }] : []),
  ];
  const started = catalog?.filter((d) => d.count > 0).length ?? 0;
  const entries = catalog?.reduce((n, d) => n + d.count, 0) ?? 0;

  const backup = () => run(() => post('/api/v1/node/backups'), 'Backup complete').then(() => { refresh(); reload(); });

  return (
    <div data-screen-label="Dashboard" style={{ maxWidth: 1040 }}>
      <h1>{greeting()}, {firstName(owner.displayName)}.</h1>
      <p className="text-muted" style={{ marginBottom: 28 }}>Everything here belongs to you, and only you decide who sees it.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,290px),1fr))', gap: 18 }}>
        <div className="card" style={{ padding: '22px 24px', gap: 12 }}>
          <div className="card-kicker">Your space</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-accent-2)' }} /><span className="card-title" style={{ fontSize: 20 }}>Online</span></div>
          {[['Address', addr(node.address)], ['Version', node.version + (node.update.available ? ' · update ready' : '')], ['Last backup', node.lastBackupAt ? whenLabel(node.lastBackupAt) : 'Not yet']].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 13 }}><span className="text-muted">{k}</span><span style={{ overflowWrap: 'anywhere', textAlign: 'right' }}>{v}</span></div>
          ))}
          <Link className="btn btn-secondary" to="/admin/settings" style={{ alignSelf: 'flex-start' }}>Settings</Link>
        </div>
        <div className="card" style={{ padding: '22px 24px', gap: 12, background: 'var(--color-accent-100)' }}>
          <div className="card-kicker">Needs you</div>
          {inbox.map((ib) => <InboxRow key={ib.key} {...ib} />)}
          {reqs && inbox.length === 0 && <div className="text-muted" style={{ fontSize: 14 }}>Nothing waiting.</div>}
        </div>
        <div className="card" style={{ padding: '22px 24px', gap: 10 }}>
          <div className="card-kicker">My life</div>
          <div className="card-title" style={{ fontSize: 20 }}>{started} of {catalog?.length ?? '…'} categories started</div>
          <div className="card-body">{entries} entries so far. Nothing is shared unless you choose to.</div>
          <div style={{ display: 'flex', gap: 4 }} aria-label="Categories started per group">
            {GROUPS.filter((g) => catalog?.some((d) => d.group === g.id)).map((g) => {
              const list = catalog!.filter((d) => d.group === g.id);
              const n = list.filter((d) => d.count).length;
              return (
                <div key={g.id} title={`${g.label}: ${n} of ${list.length}`} style={{ flex: list.length, height: 10, borderRadius: 999, background: 'var(--color-neutral-300)', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${(n / list.length) * 100}%`, background: g.ink, borderRadius: 999 }} />
                </div>
              );
            })}
          </div>
          <Link className="btn btn-secondary" to="/admin/life" style={{ alignSelf: 'flex-start' }}>Open My life</Link>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18, padding: '22px 26px', flexDirection: 'row', alignItems: 'center', gap: 22, flexWrap: 'wrap', background: 'var(--color-neutral-900)', color: 'var(--color-neutral-100)', position: 'relative', overflow: 'hidden' }}>
        <div aria-hidden style={{ position: 'absolute', right: -70, top: -90, width: 260, height: 260, borderRadius: '50%', background: 'var(--color-accent-700)', opacity: 0.5 }} />
        <div aria-hidden style={{ position: 'absolute', right: 150, bottom: -60, width: 120, height: 120, borderRadius: '50%', background: 'var(--color-accent-2-700)', opacity: 0.5 }} />
        <div style={{ flex: 1, minWidth: 260, position: 'relative' }}>
          <div className="card-kicker" style={{ color: 'var(--color-accent-300)' }}>AI assistants</div>
          <div className="card-title" style={{ fontSize: 22, marginTop: 4 }}>Give an assistant access to what you choose</div>
          <div style={{ fontSize: 13, color: 'var(--color-neutral-400)', marginTop: 4, maxWidth: 560 }}>It gets its own key. You pick which categories it can read, and you can revoke it at any time.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', position: 'relative' }}>
          <Link className="btn btn-primary" to="/admin/apps?preset=assistant" style={{ background: 'var(--color-accent-2-600)' }}>Connect an assistant</Link>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,420px),1fr))', gap: 28, marginTop: 32 }}>
        <div>
          <h4>Recent activity</h4>
          {audit?.items.map((a) => (
            <div key={a._id} style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--color-divider)', alignItems: 'flex-start' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 7, flex: 'none', background: TONE[a.tone] }} />
              <div style={{ flex: 1, fontSize: 14 }}>{a.text}</div>
              <span className="text-muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{ago(a.at)}</span>
            </div>
          ))}
          {node.publicViewsToday > 0 && (
            <div style={{ display: 'flex', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--color-divider)', alignItems: 'flex-start' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 7, flex: 'none', background: TONE.system }} />
              <div style={{ flex: 1, fontSize: 14 }}>Public profile viewed {node.publicViewsToday} time{node.publicViewsToday === 1 ? '' : 's'}</div>
              <span className="text-muted" style={{ fontSize: 12 }}>today</span>
            </div>
          )}
          {audit && audit.items.length === 0 && <p className="text-muted" style={{ fontSize: 14 }}>Nothing yet.</p>}
        </div>
        <div>
          <h4>Quick actions</h4>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            <button className="btn btn-secondary" onClick={() => setModal('add')}>Add a contact</button>
            <button className="btn btn-secondary" onClick={() => setModal('invite')}>Create invite link</button>
            <Link className="btn btn-secondary" to="/admin/public">Edit public profile</Link>
            <Link className="btn btn-secondary" to="/admin/apps?new=1">New API key</Link>
            <button className="btn btn-secondary" onClick={backup}>Back up now</button>
          </div>
        </div>
      </div>
      {modal && <AddContact initialTab={modal === 'invite' ? 'invite' : 'person'} onClose={() => setModal(null)} onDone={(id) => { setModal(null); if (id) nav(`/admin/contacts/${id}`); }} />}
    </div>
  );
}

function InboxRow({ initials: ini, title, sub, cta, go }: { initials: string; title: string; sub: string; cta: string; go: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <span style={{ width: 38, height: 38, borderRadius: '50%', background: 'var(--color-accent-300)', display: 'grid', placeItems: 'center', fontSize: 13, flex: 'none' }}>{ini}</span>
      <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 14 }}>{title}</div><div className="text-muted" style={{ fontSize: 12 }}>{sub}</div></div>
      <button className="btn btn-primary" onClick={go} style={{ fontSize: 13 }}>{cta}</button>
    </div>
  );
}
