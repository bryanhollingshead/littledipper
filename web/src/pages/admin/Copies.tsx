import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, copy as toClipboard, del, firstName, get, longDate, post, type Contact } from '../../api';
import { Confirm, Dialog, Pills, useAction, useAsync, useToast, type ConfirmCfg } from '../../ui';
import { fmtRange, Select, type Domain, type Rec } from '../../life';

export type CopyOut = {
  id: string; title: string; note: string; delivery: 'link' | 'file' | 'inline';
  items: { domain: string; entries: number; includeSecret: boolean }[];
  contact: { id: string; displayName: string } | null; sentTo: string | null;
  link: { active: boolean; expiresAt: string | null; revokedAt: string | null } | null;
  views: number; downloads: number; lastViewedAt: string | null; createdAt: string;
};
type Created = { copy: CopyOut; url: string | null; contact: { id: string; displayName: string; created: boolean } | null; email: { to: string; subject: string; body: string } };
type Choice = { records: Rec[]; chosen: string[]; includeSecret: boolean };

const HOURS: [string, string][] = [['24', '1 day'], ['168', '7 days'], ['720', '30 days'], ['0', 'Until I turn it off']];
const FORMATS: [string, string][] = [['pdf', 'PDF'], ['json', 'JSON'], ['txt', 'Text']];
const secretParts = (d: Domain) => d.parts.filter((p) => p.sensitivity === 'secret');

const Check = ({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) => (
  <button type="button" role="checkbox" aria-checked={on} className="bare" onClick={onClick} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 14, textAlign: 'left', width: '100%', padding: '6px 0' }}>
    <span style={{ width: 18, height: 18, marginTop: 1, flex: 'none', borderRadius: 6, border: '2px solid var(--color-accent)', background: on ? 'var(--color-accent)' : 'transparent', color: 'var(--color-bg)', display: 'grid', placeItems: 'center', fontSize: 11 }}>{on ? '✓' : ''}</span>
    <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
  </button>
);

/**
 * Send a copy of entries to someone without a Little Dipper: a link that can end, a file to attach, or text in the email.
 * With an email address they're added to your contacts. The node never sends the email itself; your mail app does.
 */
export function SendCopy({ catalog, start, contact, onClose, onSent }: { catalog: Domain[]; start?: string; contact?: Pick<Contact, 'id' | 'displayName' | 'methods'>; onClose: () => void; onSent?: () => void }) {
  const toast = useToast();
  const { run, busy } = useAction();
  const [picks, setPicks] = useState<Record<string, Choice>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [email, setEmail] = useState(contact?.methods.find((m) => m.type === 'email')?.value ?? '');
  const [name, setName] = useState('');
  const [contactId, setContactId] = useState(contact?.id ?? '');
  const [delivery, setDelivery] = useState<'link' | 'file' | 'inline'>('link');
  const [hours, setHours] = useState('168');
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [done, setDone] = useState<Created | null>(null);
  const { data: people } = useAsync(() => (contact ? Promise.resolve({ items: [] as Contact[] }) : get<{ items: Contact[] }>('/api/v1/contacts')), []);

  const addDomain = async (id: string) => {
    const d = catalog.find((x) => x.id === id);
    if (!d || picks[id]) return;
    const r = await run(() => get<{ items: Rec[] }>(`/api/v1/data/${id}`));
    if (!r) return;
    setPicks((p) => ({ ...p, [id]: { records: r.items, chosen: r.items.map((x) => x.id), includeSecret: d.sensitivity === 'secret' } }));
    setOrder((o) => (o.includes(id) ? o : [...o, id]));
  };
  // The category you started from is already picked.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (start) addDomain(start); }, [start]);

  const set = (id: string, p: Partial<Choice>) => setPicks((all) => ({ ...all, [id]: { ...all[id], ...p } }));
  const remove = (id: string) => { setOrder((o) => o.filter((x) => x !== id)); setPicks(({ [id]: _, ...rest }) => rest); };
  const known = people?.items.find((c) => c.methods.some((m) => m.type === 'email' && m.value.toLowerCase() === email.trim().toLowerCase()));
  const chosenContact = contact ?? people?.items.find((c) => c.id === contactId);
  const isNew = !chosenContact && !known && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const count = order.reduce((n, id) => n + picks[id].chosen.length, 0);
  const withSecret = order.filter((id) => picks[id].includeSecret && secretParts(catalog.find((d) => d.id === id)!).length);

  const send = async (confirmed: boolean) => {
    const body = {
      items: order.map((id) => ({ domain: id, recordIds: picks[id].chosen, includeSecret: picks[id].includeSecret })),
      to: chosenContact ? { contactId: chosenContact.id, email: email.trim() || undefined } : email.trim() ? { email: email.trim(), name: name.trim() || undefined } : undefined,
      delivery, hours: Number(hours), note, confirm: confirmed,
    };
    try {
      const r = await post<Created>('/api/v1/copies', body);
      setDone(r);
      onSent?.();
      if (r.url && (await toClipboard(r.url))) toast('Link copied');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirm_required') {
        const labels = withSecret.map((id) => catalog.find((d) => d.id === id)!.label);
        setConfirm({
          title: 'Include secret details?',
          body: <>The copy will include secret details from {labels.join(' and ')}: {withSecret.flatMap((id) => secretParts(catalog.find((d) => d.id === id)!).map((p) => p.label.toLowerCase())).join(', ')}. {delivery === 'link' ? 'Anyone with the link can see them until it ends.' : 'Once sent, they can’t be taken back.'}</>,
          cta: 'Include them',
          onConfirm: async () => { setConfirm(null); await send(true); },
        });
      } else toast((e as Error).message);
    }
  };

  if (done) return <CopyDone done={done} onClose={onClose} />;
  const addable = catalog.filter((d) => d.count > 0 && !picks[d.id]);
  const recipientName = chosenContact?.displayName ?? known?.displayName ?? (name.trim() || null);

  return (
    <Dialog title="Send a copy" onClose={onClose} width={620} actions={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !count} onClick={() => run(() => send(false))}>
        {delivery === 'link' ? 'Create link' : 'Make the copy'}
      </button>
    </>}>
      <div className="dialog-body" style={{ opacity: 1, display: 'grid', gap: 18 }}>
        <div style={{ fontSize: 14 }}>They get these entries <strong>as they are today</strong>. Changes you make later won’t reach them. Notes stay private.</div>

        {/* what */}
        <div className="field">
          <label>What to send</label>
          {order.map((id) => {
            const d = catalog.find((x) => x.id === id)!;
            const p = picks[id];
            const secret = secretParts(d);
            return (
              <div key={id} className="card" style={{ padding: '12px 16px', gap: 2, background: 'var(--color-neutral-100)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <strong style={{ flex: 1 }}>{d.label}</strong>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => set(id, { chosen: p.chosen.length === p.records.length ? [] : p.records.map((r) => r.id) })}>{p.chosen.length === p.records.length ? 'None' : 'All'}</button>
                  {order.length > 1 && <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => remove(id)}>Remove</button>}
                </div>
                {p.records.length === 0 && <div className="text-muted" style={{ fontSize: 13 }}>Nothing here yet.</div>}
                {p.records.map((r) => (
                  <Check key={r.id} on={p.chosen.includes(r.id)} onClick={() => set(id, { chosen: p.chosen.includes(r.id) ? p.chosen.filter((x) => x !== r.id) : [...p.chosen, r.id] })}>
                    {r.title}{d.dated && (r.validFrom || r.validTo) ? <span className="text-muted" style={{ fontSize: 12 }}> · {fmtRange(r.validFrom, r.validTo)}</span> : null}
                  </Check>
                ))}
                {secret.length > 0 && p.records.length > 0 && (
                  <div style={{ borderTop: '1px solid var(--color-divider)', marginTop: 6, paddingTop: 4 }}>
                    <Check on={p.includeSecret} onClick={() => set(id, { includeSecret: !p.includeSecret })}>
                      Include secret details <span className="text-muted" style={{ fontSize: 12 }}>({secret.map((x) => x.label).join(', ')})</span>
                      {!p.includeSecret && d.sensitivity === 'secret' && <div className="text-muted" style={{ fontSize: 12 }}>Without them, most of {d.label} shows as ••••.</div>}
                    </Check>
                  </div>
                )}
              </div>
            );
          })}
          {addable.length > 0 && <Select value="" onChange={(v) => v && addDomain(v)} options={addable.map((d) => [d.id, d.label])} placeholder={order.length ? 'Add another category…' : 'Choose a category…'} />}
        </div>

        {/* who */}
        <div className="field">
          <label htmlFor="cpto">Who it’s for <span className="text-muted" style={{ fontWeight: 400 }}>(optional)</span></label>
          {contact ? <div style={{ fontSize: 14 }}>{contact.displayName}</div> : (
            <Select value={contactId} onChange={(v) => { setContactId(v); const c = people?.items.find((x) => x.id === v); setEmail(c?.methods.find((m) => m.type === 'email')?.value ?? ''); }}
              options={(people?.items ?? []).map((c) => [c.id, c.displayName])} placeholder="Someone new, or no one in particular" />
          )}
          <input id="cpto" className="input" type="email" placeholder="Their email address" value={email} onChange={(e) => { setEmail(e.target.value); if (!contact) setContactId(''); }} />
          {isNew && <input className="input" aria-label="Their name" placeholder="Their name (optional)" value={name} onChange={(e) => setName(e.target.value)} />}
          <div className="text-muted" style={{ fontSize: 12 }}>
            {isNew ? `We’ll add ${name.trim() || 'them'} to your contacts, so you can see what you’ve sent them.`
              : known && !chosenContact ? `${known.displayName} is already in your contacts.`
                : email.trim() ? 'We write the email; you send it from your own email app.'
                  : 'Leave it empty to just make a link or a file.'}
          </div>
        </div>

        {/* how */}
        <div className="field">
          <label>How they get it</label>
          <Pills value={delivery} onChange={setDelivery} size={13} options={[['link', 'A link'], ['file', 'A file to attach'], ['inline', 'In the email']]} />
          {delivery === 'link' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>The link works for</span>
              <Select value={hours} onChange={(v) => v && setHours(v)} options={HOURS} style={{ width: 190 }} />
            </div>
          )}
          <div style={{ fontSize: 13, background: 'var(--color-accent-100)', borderRadius: 16, padding: '10px 14px', display: 'grid', gap: 4 }}>
            {delivery === 'link' ? <>
              <span>Anyone with the link can open it, so send it only to them. You’ll see when it’s opened, and you can turn it off at any time.</span>
              <span>From the page they can save a PDF, JSON or text file. A saved file is theirs to keep.</span>
            </> : delivery === 'file' ? (
              <span>You’ll download a PDF, JSON or text file and attach it to your email. <strong>Once sent, it’s theirs to keep.</strong> It can’t expire or be taken back.</span>
            ) : (
              <span>The details go into the email as plain text. <strong>Once sent, it’s theirs to keep.</strong> Email isn’t private, so leave out anything you wouldn’t put on a postcard.</span>
            )}
          </div>
        </div>

        <div className="field">
          <label htmlFor="cpnote">Note {recipientName ? `to ${firstName(recipientName)}` : ''} <span className="text-muted" style={{ fontWeight: 400 }}>(optional)</span></label>
          <input id="cpnote" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For the rental application" />
        </div>
        <div className="text-muted" style={{ fontSize: 12 }}>
          {count ? `${count} entr${count === 1 ? 'y' : 'ies'}${withSecret.length ? ', with secret details' : ''}.` : 'Choose at least one entry.'} Nothing leaves your Little Dipper until you send it.
        </div>
      </div>
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </Dialog>
  );
}

/** After the copy is made: the link, the files, and the email for the owner's own mail app. */
function CopyDone({ done, onClose }: { done: Created; onClose: () => void }) {
  const toast = useToast();
  const { copy: c, url, contact, email } = done;
  const mailto = email.to ? `mailto:${encodeURIComponent(email.to)}?subject=${encodeURIComponent(email.subject)}&body=${encodeURIComponent(email.body)}` : '';
  return (
    <Dialog title={c.delivery === 'link' ? 'Your link is ready' : 'Your copy is ready'} onClose={onClose} width={560} actions={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <div className="dialog-body" style={{ opacity: 1, display: 'grid', gap: 16 }}>
        {contact?.created && <div style={{ fontSize: 14 }}><Link to={`/admin/contacts/${contact.id}`}>{contact.displayName}</Link> was added to your contacts.</div>}
        {url && (
          <div className="field">
            <label>Link{c.link?.expiresAt ? ` · works until ${longDate(c.link.expiresAt)}` : ' · works until you turn it off'}</label>
            <div className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', background: 'var(--color-neutral-200)', borderRadius: 12, padding: '8px 10px' }}>{url}</div>
            <button className="btn btn-secondary" style={{ justifySelf: 'start', fontSize: 13 }} onClick={async () => toast((await toClipboard(url)) ? 'Link copied' : 'Couldn’t copy. Select the link instead.')}>Copy link</button>
          </div>
        )}
        {c.delivery === 'file' && (
          <div className="field">
            <label>Download, then attach it to your email</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {FORMATS.map(([f, l]) => <a key={f} className="btn btn-secondary" style={{ fontSize: 13 }} href={`/api/v1/copies/${c.id}/download?format=${f}`}>{l}</a>)}
            </div>
            <div className="text-muted" style={{ fontSize: 12 }}>PDF to read or print, JSON for software, text for anything else.</div>
          </div>
        )}
        <div className="field">
          <label>{email.to ? `Email to ${email.to}` : 'Message'}</label>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, margin: 0, background: 'var(--color-neutral-100)', borderRadius: 16, padding: 12, maxHeight: 220, overflow: 'auto', fontFamily: 'inherit' }}>{email.body}</pre>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {mailto && <a className="btn btn-primary" style={{ fontSize: 13 }} href={mailto}>Open in my email app</a>}
            <button className="btn btn-secondary" style={{ fontSize: 13 }} onClick={async () => toast((await toClipboard(email.body)) ? 'Message copied' : 'Couldn’t copy the message')}>Copy message</button>
          </div>
          {mailto && c.delivery === 'inline' && email.body.length > 1800 && <div className="text-muted" style={{ fontSize: 12 }}>Some email apps cut long messages opened this way. If yours does, use Copy message and paste it in.</div>}
        </div>
      </div>
    </Dialog>
  );
}

const DELIVERY_LABEL = { link: 'Link', file: 'File', inline: 'In an email' };

/** Copies you've sent: for one contact or one category. Links can be turned off; files can be downloaded again. */
export function CopyList({ query, heading, showContact = true, version = 0 }: { query: string; heading?: React.ReactNode; showContact?: boolean; version?: number }) {
  const { run } = useAction();
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const { data, reload } = useAsync(() => get<{ items: CopyOut[] }>(`/api/v1/copies?${query}`), [query, version]);
  if (!data?.items.length) return null;
  const status = (c: CopyOut) => {
    if (!c.link) return `${DELIVERY_LABEL[c.delivery]} · kept by them`;
    if (c.link.revokedAt) return 'Link turned off';
    if (!c.link.active) return `Link ended ${longDate(c.link.expiresAt!)}`;
    return c.link.expiresAt ? `Link open until ${longDate(c.link.expiresAt)}` : 'Link open until you turn it off';
  };
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      {heading}
      {data.items.map((c) => (
        <div key={c.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '10px 0', borderBottom: '1px solid var(--color-divider)' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 14 }}>
              {c.title}{showContact && c.contact ? <> · <Link to={`/admin/contacts/${c.contact.id}`}>{c.contact.displayName}</Link></> : null}
            </div>
            <div className="text-muted" style={{ fontSize: 12 }}>
              {longDate(c.createdAt)} · {status(c)}{c.link ? ` · opened ${c.views} time${c.views === 1 ? '' : 's'}` : ''}{c.downloads ? ` · saved ${c.downloads}×` : ''}
            </div>
          </div>
          {c.link?.active && <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={async () => { if (await run(() => del(`/api/v1/copies/${c.id}`), 'Link turned off')) reload(); }}>Turn off</button>}
          <a className="btn btn-ghost" style={{ fontSize: 12 }} href={`/api/v1/copies/${c.id}/download?format=pdf`}>PDF</a>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} aria-label="Delete from history" onClick={() => setConfirm({
            title: 'Delete this from your history?', body: `${c.link?.active ? 'The link stops working, and y' : 'Y'}ou won’t see this copy here any more. Anything they already saved stays with them.`, cta: 'Delete',
            onConfirm: async () => { setConfirm(null); if (await run(() => del(`/api/v1/copies/${c.id}?forget=1`))) reload(); },
          })}>×</button>
        </div>
      ))}
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
