import { useState } from 'react';
import { copy, firstName, get, initials, post, SENS, type Field } from '../../api';
import { Dialog, Pills, QR, Striped, Toggle, useAction, useAsync, useToast } from '../../ui';
import { useAdmin } from './Layout';

type Tab = 'person' | 'node' | 'invite';
type Lookup = { nodeId: string; displayName: string | null; address: string; version: string; signingKey: string; viaInvite: boolean; acceptsRequests: boolean; existing: { contactId: string; status: string } | null };

export default function AddContact({ initialTab = 'person', onClose, onDone }: { initialTab?: Tab; onClose: () => void; onDone: (contactId?: string) => void }) {
  const { tech } = useAdmin();
  const toast = useToast();
  const { run, busy } = useAction();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [person, setPerson] = useState({ name: '', email: '', phone: '', address: '' });
  const [nodeUrl, setNodeUrl] = useState('');
  const [found, setFound] = useState<Lookup | null>(null);
  const [lookupError, setLookupError] = useState('');
  const [offer, setOffer] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const [exp, setExp] = useState<'24h' | '7d' | '30d'>('7d');
  const [invite, setInvite] = useState<{ url: string; expiresAt: string } | null>(null);
  const { data: fields } = useAsync(() => get<{ items: Field[] }>('/api/v1/owner/fields'), []);

  const sensitive = (fields?.items || []).filter((f) => f.sensitivity === 'sensitive' && f.hasValue);
  const name = found?.displayName || found?.address || '';

  const lookup = async () => {
    setLookupError('');
    setFound(null);
    try {
      setFound(await post<Lookup>('/api/v1/federation/lookup', { address: nodeUrl }));
    } catch (e) {
      setLookupError((e as Error).message);
    }
  };

  const savePerson = async () => {
    if (!person.name.trim()) return toast('Add a name first');
    const r = await run(() => post('/api/v1/contacts', { displayName: person.name, email: person.email, phone: person.phone, address: person.address }), `${person.name} added`);
    if (r) onDone(r.id);
  };

  const send = async () => {
    const r = await run(() => post('/api/v1/federation/requests', { address: nodeUrl, offeredFields: Object.keys(offer).filter((k) => offer[k]), note }), `Request sent to ${firstName(name)}`);
    if (r) onDone(r.contactId);
  };

  const createInvite = async () => {
    const r = await run(() => post('/api/v1/federation/invites', { expiresIn: exp }));
    if (r) setInvite(r);
  };

  return (
    <Dialog title="Add a contact" onClose={onClose} width={560} actions={
      tab === 'person' ? <>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={savePerson}>Save contact</button>
      </> : tab === 'node' ? <>
        <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !found || !found.acceptsRequests || !!found.existing} onClick={send}>Send connection request</button>
      </> : <>
        <button className="btn btn-secondary" onClick={() => onDone()}>Done</button>
        {invite
          ? <button className="btn btn-primary" onClick={async () => { await copy(invite.url); toast('Invite link copied'); }}>Copy link</button>
          : <button className="btn btn-primary" disabled={busy} onClick={createInvite}>Create link</button>}
      </>
    }>
      <Pills value={tab} options={[['person', 'Person'], ['node', 'On Little Dipper'], ['invite', 'Invite link']]} onChange={setTab} />

      {tab === 'person' && (
        <form className="dialog-body" style={{ opacity: 1, display: 'grid', gap: 12 }} onSubmit={(e) => { e.preventDefault(); savePerson(); }}>
          <div className="text-muted" style={{ fontSize: 13 }}>For people who don't use Little Dipper. Stored only on your Little Dipper; nothing is sent to them.</div>
          <div className="field"><label htmlFor="cn">Name</label><input id="cn" className="input" value={person.name} onChange={(e) => setPerson({ ...person, name: e.target.value })} /></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 12 }}>
            <div className="field"><label htmlFor="ce">Email</label><input id="ce" className="input" type="email" value={person.email} onChange={(e) => setPerson({ ...person, email: e.target.value })} /></div>
            <div className="field"><label htmlFor="cp">Phone</label><input id="cp" className="input" type="tel" value={person.phone} onChange={(e) => setPerson({ ...person, phone: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor="ca">Address</label><input id="ca" className="input" value={person.address} onChange={(e) => setPerson({ ...person, address: e.target.value })} /></div>
          <button type="submit" hidden />
        </form>
      )}

      {tab === 'node' && (
        <div className="dialog-body" style={{ opacity: 1, display: 'grid', gap: 12 }}>
          <div className="text-muted" style={{ fontSize: 13 }}>Enter the address of their Little Dipper, or paste an invite link they sent you. We'll find them and send a request for you.</div>
          <form style={{ display: 'flex', gap: 8 }} onSubmit={(e) => { e.preventDefault(); lookup(); }}>
            <input className="input mono" aria-label="Their address" placeholder="theo.nakamura.net" value={nodeUrl} onChange={(e) => { setNodeUrl(e.target.value); setFound(null); setLookupError(''); }} />
            <button type="submit" className="btn btn-secondary" disabled={!nodeUrl.trim()}>Look up</button>
          </form>
          {lookupError && <div style={{ fontSize: 13, color: 'var(--color-accent-700)' }}>{lookupError}</div>}
          {found && (
            <>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '12px 16px', borderRadius: 22, background: 'var(--color-accent-2-100)' }}>
                <span style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--color-accent-2-300)', display: 'grid', placeItems: 'center', fontSize: 13, flex: 'none' }}>{initials(name)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{name}</div>
                  <div className="mono" style={{ fontSize: 12, color: 'var(--color-accent-2-800)', overflowWrap: 'anywhere' }}>{found.address}{tech ? ` · v${found.version} · key ${found.signingKey}` : ' · identity confirmed'}</div>
                </div>
              </div>
              {found.existing ? (
                <div style={{ fontSize: 13 }}>{firstName(name)} is already in your contacts. <button className="btn btn-ghost" onClick={() => onDone(found.existing!.contactId)}>Open their page</button></div>
              ) : !found.acceptsRequests ? (
                <div style={{ fontSize: 13, color: 'var(--color-accent-800)' }}>{firstName(name)} isn't accepting connection requests right now. Ask them for an invite link and paste it above.</div>
              ) : (
                <>
                  <div style={{ fontSize: 13, marginTop: 4 }}>{firstName(name)} will get your <strong>basic profile</strong>.{sensitive.length > 0 && ' Also offer:'}</div>
                  {sensitive.map((f) => (
                    <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: '1px solid var(--color-divider)' }}>
                      <span style={{ flex: 1, fontSize: 14 }}>{f.label}</span><span className={`tag ${SENS[f.sensitivity][1]}`}>{SENS[f.sensitivity][0]}</span>
                      <Toggle on={!!offer[f.key]} label={`Offer ${f.label}`} onChange={() => setOffer({ ...offer, [f.key]: !offer[f.key] })} />
                    </div>
                  ))}
                  <div className="field"><label htmlFor="nt">Note to {firstName(name)} (optional)</label><input id="nt" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Hey, it's me from the studio" /></div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'invite' && (
        <div className="dialog-body" style={{ opacity: 1, display: 'grid', gap: 14 }}>
          <div className="text-muted" style={{ fontSize: 13 }}>Share in person or by message. When they open it in their Little Dipper, you get a request to approve. People who don't have Little Dipper yet see how to get it.</div>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
            {invite ? <QR text={invite.url} /> : <Striped size={150} radius={24} label="QR code" />}
            <div style={{ flex: 1, minWidth: 200, display: 'grid', gap: 10 }}>
              <div className="mono" style={{ fontSize: 12, background: 'var(--color-neutral-100)', borderRadius: 16, padding: '10px 14px', overflowWrap: 'anywhere', color: invite ? undefined : 'var(--color-neutral-500)' }}>{invite ? invite.url : 'Your link appears here'}</div>
              {!invite && <Pills value={exp} size={12} options={[['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']]} onChange={setExp} />}
              <div className="text-muted" style={{ fontSize: 12 }}>Single use{invite ? ` · expires ${new Date(invite.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}` : ''}. Offers your basic profile.</div>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
