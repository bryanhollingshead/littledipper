import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, initials, post, whenLabel, ago, type Contact, type Conversation, type Message } from '../../api';
import { Dialog, ErrorNote, Loading, useAction, useAsync } from '../../ui';
import { useAdmin } from './Layout';

const POLL_MS = 5000;

/** Why a message wasn't delivered, in words. */
const FAILURE: Record<string, string> = {
  not_connected: "You're no longer connected",
  not_supported: "Their Little Dipper can't receive messages yet",
  peer_unreachable: "Couldn't reach their Little Dipper",
};

function statusLine(m: Message) {
  if (m.direction === 'in') return whenLabel(m.createdAt);
  if (m.status === 'delivered' || m.status === 'read') return `${whenLabel(m.createdAt)} · Delivered`;
  if (m.status === 'queued') return m.lastError ? `Not delivered yet · will keep trying` : 'Sending…';
  return `Not delivered · ${FAILURE[m.lastError || ''] || "Couldn't reach their Little Dipper"}`;
}

/** Text today. Other kinds are shown as a placeholder until this version learns them. */
const bodyText = (m: Message) => (m.kind === 'text' ? String(m.body) : `This message (${m.kind}) can't be shown in this version of Little Dipper.`);

const Avatar = ({ name, size = 36 }: { name: string; size?: number }) => (
  <span style={{ width: size, height: size, borderRadius: '50%', background: 'var(--color-accent-2-200)', display: 'grid', placeItems: 'center', fontSize: 12, flex: 'none' }}>{initials(name)}</span>
);

export default function Messages() {
  const { contactId } = useParams();
  const nav = useNavigate();
  const [picking, setPicking] = useState(false);
  const { data, error, reload } = useAsync(() => get<{ items: Conversation[] }>('/api/v1/messages/conversations'), []);

  useEffect(() => {
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <ErrorNote error={error} />;

  return (
    <div data-screen-label="Messages" style={{ maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div><h1>Messages</h1><p className="text-muted" style={{ margin: 0 }}>Private messages with your connections, sent straight from your Little Dipper to theirs.</p></div>
        <button className="btn btn-primary" onClick={() => setPicking(true)}>New message</button>
      </div>

      <div className="inbox" data-open={contactId ? '1' : '0'} style={{ marginTop: 24 }}>
        <div className="inbox-list" style={{ display: 'grid', gap: 4, alignContent: 'start' }}>
          {!data ? <Loading /> : data.items.length === 0 ? (
            <p className="text-muted" style={{ fontSize: 14 }}>No messages yet. Start one with someone you're connected to.</p>
          ) : data.items.map((c) => (
            <button key={c.contact.id} className="bare nav-pill" aria-current={c.contact.id === contactId ? 'page' : undefined} onClick={() => nav(`/admin/messages/${c.contact.id}`)}
              style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 12px', borderRadius: 20, whiteSpace: 'normal' }}>
              <Avatar name={c.contact.displayName} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontWeight: c.unread ? 700 : 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.contact.displayName}</span>
                  <span className="text-muted" style={{ fontSize: 11, flex: 'none' }}>{ago(c.last.at)}</span>
                </span>
                <span className="text-muted" style={{ display: 'block', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.last.direction === 'out' ? 'You: ' : ''}{c.last.preview}</span>
              </span>
              {c.unread > 0 && <span style={{ minWidth: 20, height: 20, borderRadius: 999, background: 'var(--color-accent)', color: 'var(--color-bg)', fontSize: 11, display: 'grid', placeItems: 'center', padding: '0 6px' }}>{c.unread}</span>}
            </button>
          ))}
        </div>
        <div className="inbox-thread">
          {contactId ? <Thread key={contactId} contactId={contactId} onChange={reload} /> : (
            <div className="card text-muted" style={{ padding: '28px 24px', fontSize: 14 }}>Pick a conversation, or start a new one.</div>
          )}
        </div>
      </div>

      {picking && <PickContact onClose={() => setPicking(false)} onPick={(id) => { setPicking(false); nav(`/admin/messages/${id}`); }} />}
    </div>
  );
}

function Thread({ contactId, onChange }: { contactId: string; onChange: () => void }) {
  const { refresh } = useAdmin();
  const { run, busy } = useAction();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const { data, error, reload } = useAsync(() => get<{ contact: Conversation['contact']; canMessage: boolean; items: Message[] }>(`/api/v1/messages/conversations/${contactId}`), [contactId]);

  useEffect(() => {
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  // Opening a conversation reads it: clear its unread count and the sidebar badge.
  const unread = data?.items.filter((m) => m.direction === 'in' && m.status === 'received').length ?? 0;
  useEffect(() => {
    if (!unread) return;
    post(`/api/v1/messages/conversations/${contactId}/read`).then(() => { refresh(); onChange(); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread, contactId]);

  const count = data?.items.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [count]);

  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const name = data.contact.displayName;

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    const m = await run(() => post<Message>(`/api/v1/messages/conversations/${contactId}`, { body }));
    if (m) { setText(''); reload(); onChange(); }
  };
  const retry = async (m: Message) => { if (await run(() => post(`/api/v1/messages/${m.id}/retry`))) { reload(); onChange(); } };

  return (
    <div className="card" style={{ padding: 0, gap: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--color-divider)' }}>
        <Link className="btn btn-ghost inbox-back" to="/admin/messages" aria-label="All conversations" style={{ padding: '6px 10px' }}>←</Link>
        <Avatar name={name} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Link to={`/admin/contacts/${data.contact.id}`} style={{ fontWeight: 600, color: 'inherit', textDecoration: 'none' }}>{name}</Link>
          {data.contact.node && <div className="text-muted mono" style={{ fontSize: 12 }}>{data.contact.node.url}</div>}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 10, padding: '18px 20px', maxHeight: '58vh', overflow: 'auto', alignContent: 'start' }}>
        {data.items.length === 0 && <p className="text-muted" style={{ fontSize: 14, margin: 0 }}>No messages yet. Say hello to {name}.</p>}
        {data.items.map((m) => {
          const mine = m.direction === 'out';
          return (
            <div key={m.id} style={{ display: 'grid', justifyItems: mine ? 'end' : 'start', gap: 3 }}>
              <div style={{ maxWidth: 'min(520px, 85%)', padding: '10px 14px', borderRadius: 20, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14,
                background: mine ? 'var(--color-accent-2-200)' : 'var(--color-neutral-100)', fontStyle: m.kind === 'text' ? 'normal' : 'italic', opacity: m.status === 'failed' ? 0.6 : 1 }}>
                {bodyText(m)}
              </div>
              <div className="text-muted" style={{ fontSize: 11, display: 'flex', gap: 8, alignItems: 'center' }}>
                {statusLine(m)}
                {m.status === 'failed' && <button className="btn btn-ghost" disabled={busy} style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => retry(m)}>Retry</button>}
              </div>
            </div>
          );
        })}
        <div ref={end} />
      </div>

      <div style={{ padding: '14px 20px 18px', borderTop: '1px solid var(--color-divider)' }}>
        {data.canMessage ? (
          <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <textarea className="input" aria-label={`Message ${name}`} placeholder={`Message ${name}`} value={text} rows={2} maxLength={10000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              style={{ flex: 1, borderRadius: 20, resize: 'vertical', minHeight: 44 }} />
            <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>Send</button>
          </form>
        ) : (
          <div className="text-muted" style={{ fontSize: 13 }}>You can message {name} while you're connected. <Link to={`/admin/contacts/${data.contact.id}`}>View contact</Link></div>
        )}
      </div>
    </div>
  );
}

function PickContact({ onClose, onPick }: { onClose: () => void; onPick: (id: string) => void }) {
  const { data, error } = useAsync(() => get<{ items: Contact[] }>('/api/v1/contacts'), []);
  const connected = (data?.items || []).filter((c) => c.kind === 'node' && c.status === 'active');
  return (
    <Dialog title="New message" onClose={onClose} width={440}>
      {error ? <ErrorNote error={error} /> : !data ? <Loading /> : connected.length === 0 ? (
        <p className="text-muted" style={{ fontSize: 14 }}>You can message people you're connected to on Little Dipper. Connect with someone from <Link to="/admin/contacts" onClick={onClose}>Contacts</Link> first.</p>
      ) : (
        <div style={{ display: 'grid', gap: 4 }}>
          {connected.map((c) => (
            <button key={c.id} className="bare nav-pill" onClick={() => onPick(c.id)} style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'flex-start', padding: '10px 12px', borderRadius: 20 }}>
              <Avatar name={c.displayName} />
              <span><span style={{ display: 'block', fontWeight: 600 }}>{c.displayName}</span><span className="text-muted mono" style={{ fontSize: 12 }}>{c.node?.url}</span></span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
