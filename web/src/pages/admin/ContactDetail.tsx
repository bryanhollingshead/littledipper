import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ago, copy, del, firstName, get, initials, patch, post, put, SENS, shortDate, STATUS, type ContactDetail as CD, type Field } from '../../api';
import { Confirm, Dialog, ErrorNote, Loading, Toggle, useAction, useAsync, useToast, type ConfirmCfg } from '../../ui';
import { useAdmin } from './Layout';
import ContactAccess from './ContactAccess';
import { fetchCatalog, fmtRange } from '../../life';
import { CopyList, SendCopy } from './Copies';

export default function ContactDetail() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { tech, refresh } = useAdmin();
  const { run, busy } = useAction();
  const { data: c, error, reload, setData } = useAsync(() => get<CD>(`/api/v1/contacts/${id}`), [id]);
  const { data: fieldsResp } = useAsync(() => get<{ items: Field[] }>('/api/v1/owner/fields'), []);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(0);
  const { data: catalog } = useAsync(fetchCatalog, []);
  const [edit, setEdit] = useState<{ notes: string; methods: { type: string; label: string; value: string }[] } | null>(null);

  if (error) return <div><Link className="btn btn-ghost" to="/admin/contacts">← All contacts</Link><ErrorNote error={error} /></div>;
  if (!c || !fieldsResp) return <Loading />;
  const fields = fieldsResp.items;
  const first = firstName(c.displayName);
  const isNode = c.kind === 'node';
  const s = c.status;
  const sub = c.node ? c.node.url : c.org || '';

  const accept = async () => {
    if (!c.request) return;
    if (await run(() => post(`/api/v1/federation/requests/${c.request!.id}/accept`), 'Connected. Keys exchanged.')) { reload(); refresh(); }
  };
  const decline = async () => {
    if (!c.request) return;
    if (await run(() => post(`/api/v1/federation/requests/${c.request!.id}/decline`), 'Request declined')) { refresh(); nav('/admin/contacts'); }
  };
  const resend = () => c.request && run(() => post(`/api/v1/federation/requests/${c.request!.id}/resend`), 'Request re-sent');
  const rotate = async () => {
    if (await run(() => post(`/api/v1/federation/links/${c.node!.linkId}/rotate`), 'Keys rotated. Their Little Dipper was notified.')) reload();
  };
  const disconnect = () => setConfirm({
    title: `Disconnect ${c.displayName}?`, body: 'They will no longer see anything you shared. They stay in your contacts.', cta: 'Disconnect',
    onConfirm: async () => {
      const r = await run(() => del<{ peerNotified: boolean }>(`/api/v1/federation/links/${c.node!.linkId}`), (r) => (r.peerNotified ? 'Disconnected' : "Disconnected. Their Little Dipper couldn't be reached; it'll find out next time it asks."));
      setConfirm(null);
      if (r) reload();
    },
  });
  const remove = () => setConfirm({
    title: `Delete ${c.displayName}?`, body: isNode ? 'This disconnects you and removes them from your contacts.' : 'This removes them and everything you noted about them.', cta: 'Delete',
    onConfirm: async () => { if (await run(() => del(`/api/v1/contacts/${c.id}`), `${c.displayName} deleted`)) nav('/admin/contacts'); setConfirm(null); },
  });
  const invite = async () => {
    const r = await run(() => post<{ url: string; to: string; subject: string; body: string }>(`/api/v1/contacts/${c.id}/invite`));
    if (!r) return;
    await copy(`${r.body}`);
    toast(r.to ? `Invite message copied. Paste it into an email to ${r.to}.` : 'Invite message copied with your invite link');
  };

  const theirTitle = s === 'active' ? `What ${first} shares with you` : s === 'pending_in' ? `${first} offers to share` : 'They share';
  const theirRows: { label: string; value: string }[] = s === 'active' ? c.sharedIn : s === 'pending_in' ? c.offered.map((l) => ({ label: l, value: 'After you accept' })) : [];
  const syncNote = s === 'active'
    ? (c.syncError ? `Couldn't reach their Little Dipper just now · showing what was fetched ${ago(c.sharedInFetchedAt)}` : c.sharedInFetchedAt ? `Fetched from their Little Dipper ${ago(c.sharedInFetchedAt)} · cached locally` : 'Not fetched yet')
    : s === 'pending_in' ? 'From their signed request. Values become available after you accept.' : 'Available once they approve.';

  return (
    <div data-screen-label="Contact detail" style={{ maxWidth: 1040 }}>
      <Link className="btn btn-ghost" to="/admin/contacts" style={{ marginBottom: 14 }}>← All contacts</Link>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ width: 72, height: 72, borderRadius: '50%', background: isNode ? 'var(--color-accent-2-200)' : 'var(--color-accent-200)', display: 'grid', placeItems: 'center', fontSize: 22, fontFamily: 'var(--font-heading)', flex: 'none' }}>{initials(c.displayName)}</span>
        <div style={{ flex: 1, minWidth: 220 }}>
          <h1 style={{ margin: 0 }}>{c.displayName}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <span className={`tag ${isNode ? 'tag-accent-2' : 'tag-neutral'}`}>{isNode ? 'On Little Dipper' : 'Person'}</span>
            <span className={`tag ${STATUS[s][1]}`}>{STATUS[s][0]}</span>
            <span className="text-muted" style={{ fontFamily: isNode ? 'var(--mono)' : 'inherit', fontSize: 12 }}>{sub}</span>
            {c.node?.nodeId && (
              <span className="text-muted" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                <button type="button" title={`${c.node.nodeId} · click to copy`} onClick={async () => toast((await copy(c.node!.nodeId)) ? 'Their ID copied' : c.node!.nodeId)}
                  style={{ all: 'unset', cursor: 'pointer', opacity: 0.75 }}>· {c.node.nodeId.slice(0, 8)}…{c.node.nodeId.slice(-4)}</button>
              </span>
            )}
          </div>
        </div>
        {!isNode && <button className="btn btn-secondary" onClick={invite}>Invite to Little Dipper</button>}
        {isNode && s === 'active' && <Link className="btn btn-primary" to={`/admin/messages/${c.id}`}>Message</Link>}
      </div>

      {s === 'pending_in' && (
        <div style={{ marginTop: 22, borderRadius: 32, background: 'var(--color-accent-100)', padding: '18px 22px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600 }}>{first} sent a connection request</div>
            <div style={{ fontSize: 13, color: 'var(--color-accent-800)' }}>Choose what they can see first, then accept. Nothing is shared until you do.{c.request?.note ? ` Their note: “${c.request.note}”` : ''}</div>
          </div>
          <button className="btn btn-secondary" disabled={busy} onClick={decline}>Decline</button>
          <button className="btn btn-primary" disabled={busy} onClick={accept}>Accept</button>
        </div>
      )}
      {s === 'pending_out' && (
        <div style={{ marginTop: 22, borderRadius: 32, background: 'var(--color-neutral-100)', padding: '18px 22px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-accent)', animation: 'ldpulse 1.6s infinite', flex: 'none' }} />
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 600 }}>Waiting for {first} to approve</div>
            <div className="text-muted" style={{ fontSize: 13 }}>Request delivered to {sub}.{c.request ? ` Expires in ${Math.max(0, Math.ceil((new Date(c.request.expiresAt).getTime() - Date.now()) / 86400_000))} days.` : ''}</div>
          </div>
          <button className="btn btn-secondary" disabled={busy} onClick={resend}>Resend</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,400px),1fr))', gap: 22, marginTop: 26, alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: 22 }}>
          <div className="card" style={{ padding: '20px 24px', gap: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="card-kicker">Contact info</div>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setEdit({ notes: c.notes, methods: c.methods.length ? c.methods : [{ type: 'email', label: 'Email', value: '' }] })}>Edit</button>
            </div>
            {c.methods.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid var(--color-divider)', flexWrap: 'wrap' }}><span className="text-muted" style={{ fontSize: 13 }}>{m.label}</span><span style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{m.value}</span></div>
            ))}
            {c.methods.length === 0 && <div className="text-muted" style={{ fontSize: 13, padding: '6px 0' }}>{isNode ? `Nothing saved yet. Whatever ${first} shares appears below.` : 'No details yet.'}</div>}
            {c.notes && <p className="text-muted" style={{ fontSize: 13, margin: '12px 0 0', whiteSpace: 'pre-wrap' }}>{c.notes}</p>}
          </div>

          <div className="card" style={{ padding: '20px 24px', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div className="card-kicker">Copies you’ve sent</div>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={!catalog} onClick={() => setSending(true)}>Send a copy</button>
            </div>
            <CopyList query={`contactId=${c.id}`} showContact={false} version={sent} />
            <div className="text-muted" style={{ fontSize: 12 }}>{isNode ? `A one-time snapshot as a link or a file, separate from what you share with ${first} here.` : `Send ${first} a snapshot of entries from My data as a link, a file or an email.`}</div>
          </div>

          {isNode && (
            <div className="card" style={{ padding: '20px 24px', gap: 4 }}>
              <div className="card-kicker">{theirTitle}</div>
              {theirRows.map((m) => (
                <div key={m.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '10px 0', borderBottom: '1px solid var(--color-divider)', flexWrap: 'wrap' }}><span className="text-muted" style={{ fontSize: 13 }}>{m.label}</span><span style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{m.value}</span></div>
              ))}
              {s === 'active' && (c.sharedDomains || []).map((sd) => (
                <div key={sd.domain} style={{ marginTop: 14 }}>
                  <div className="text-muted" style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase' }}>{sd.label}{sd.scope === 'current' ? ' · current' : ''}</div>
                  {sd.records.map((r) => (
                    <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--color-divider)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 14, fontWeight: 600 }}>{r.title}</span>
                        {(r.validFrom || r.validTo) && <span className="text-muted" style={{ fontSize: 12 }}>{fmtRange(r.validFrom, r.validTo)}</span>}
                      </div>
                      <div className="text-muted" style={{ fontSize: 12, marginTop: 2 }}>{r.fields.map((f) => `${f.label}: ${f.value}`).join(' · ')}</div>
                    </div>
                  ))}
                </div>
              ))}
              {s === 'active' && theirRows.length === 0 && !(c.sharedDomains || []).length && !c.syncError && <div className="text-muted" style={{ fontSize: 13, padding: '6px 0' }}>{first} isn't sharing anything with you yet.</div>}
              <div className="card-meta" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                {syncNote}
                {s === 'active' && <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 6px' }} disabled={busy} onClick={() => run(() => get<CD>(`/api/v1/contacts/${c.id}?sync=1`)).then((x) => x && setData(x))}>Refresh</button>}
              </div>
            </div>
          )}

          {s === 'active' && c.keys && (
            <div className="card" style={{ padding: '20px 24px', gap: 12 }}>
              <div className="card-kicker">Secure connection</div>
              <div style={{ display: 'grid', gap: 6 }}>
                {c.timeline.map((t, i) => (
                  <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent-2)', flex: 'none' }} /><span style={{ flex: 1 }}>{t.label}</span><span className="text-muted">{shortDate(t.at)}</span></div>
                ))}
                {c.keys.tokenIssued?.lastUsedAt && <div style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 13 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent-2)', flex: 'none' }} /><span style={{ flex: 1 }}>Last read of your data</span><span className="text-muted">{ago(c.keys.tokenIssued.lastUsedAt)}</span></div>}
              </div>
              {tech && [
                ['Their signing key', `${c.keys.peerSigningKey}${c.keys.peerVersion ? ` · v${c.keys.peerVersion}` : ''}`],
                ['Token you issued them', c.keys.tokenIssued ? `${c.keys.tokenIssued.prefix} · scope ${c.keys.tokenIssued.scopes.join(' ')}` : 'none'],
                ['Token they issued you', c.keys.tokenFromPeer ? `stored encrypted · last used ${ago(c.keys.tokenFromPeer.lastUsedAt)}` : 'none'],
                ['Their ID', c.node?.nodeId || ''],
              ].map(([label, value]) => (
                <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 16px', borderRadius: 18, background: 'var(--color-neutral-100)' }}>
                  <span className="text-muted" style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase' }}>{label}</span>
                  <span className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere' }}>{value}</span>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-secondary" disabled={busy} onClick={rotate}>Refresh connection</button>
                <button className="btn btn-ghost" onClick={disconnect} style={{ color: 'var(--color-accent-700)' }}>Disconnect</button>
              </div>
            </div>
          )}
          <button className="btn btn-ghost" onClick={remove} style={{ justifySelf: 'start', fontSize: 13, color: 'var(--color-accent-700)' }}>Delete contact</button>
        </div>

        {isNode && <ContactAccess c={c} fields={fields} first={first} onGrants={(g) => setData({ ...c, grants: g })} />}
      </div>

      {edit && (
        <Dialog title={`Edit ${c.displayName}`} onClose={() => setEdit(null)} width={520} actions={<>
          <button className="btn btn-secondary" onClick={() => setEdit(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => saveContact(c.id, edit), 'Saved'); if (r) { setEdit(null); reload(); } }}>Save</button>
        </>}>
          {edit.methods.map((m, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8 }}>
              <input className="input" aria-label="Label" value={m.label} onChange={(e) => setEdit({ ...edit, methods: edit.methods.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <input className="input" aria-label={m.label} value={m.value} onChange={(e) => setEdit({ ...edit, methods: edit.methods.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
            </div>
          ))}
          <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 13 }} onClick={() => setEdit({ ...edit, methods: [...edit.methods, { type: 'note', label: 'Phone', value: '' }] })}>Add a detail</button>
          <div className="field"><label htmlFor="notes">Notes</label><textarea id="notes" className="input" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} style={{ borderRadius: 20 }} /></div>
        </Dialog>
      )}
      {sending && catalog && <SendCopy catalog={catalog} contact={c} onClose={() => setSending(false)} onSent={() => setSent((n) => n + 1)} />}
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

const TYPE_BY_LABEL: Record<string, string> = { email: 'email', phone: 'phone', mobile: 'phone', address: 'address', website: 'url' };
function saveContact(id: string, e: { notes: string; methods: { type: string; label: string; value: string }[] }) {
  const methods = e.methods.filter((m) => m.value.trim()).map((m) => ({ ...m, type: TYPE_BY_LABEL[m.label.toLowerCase()] || m.type }));
  return patch(`/api/v1/contacts/${id}`, { notes: e.notes, methods });
}
