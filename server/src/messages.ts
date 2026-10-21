/**
 * Messages between contacts: one inbox, organised by contact, with the transport chosen per message.
 *
 * Shaped for more than the first version uses (docs/design/MESSAGING-AND-EMAIL.md): the sender picks the
 * message id so a retried delivery is harmless, `kind` is an open set, and `transport` leaves room for
 * email and organisation services. Today: text between connected Little Dippers over the peer protocol.
 */
import { ctx } from './ctx.js';
import { decrypt, encrypt, newId } from './crypto.js';
import { bad, HttpError } from './auth.js';
import { getNode } from './node.js';
import { lookupDescriptor, now, sendSigned, type ContactDoc, type LinkDoc } from './federation.js';
import { linkFor, touch } from './contacts.js';
import type { Doc } from './store/index.js';

export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'received' | 'read';

export type MessageDoc = Doc & {
  /** _id is chosen by the sender and is the same on both nodes. */
  contactId: string;
  /** One conversation per contact for now. Group conversations will carry their own ids. */
  conversationId: string;
  direction: 'in' | 'out';
  /** Open set: 'text' today. Clients show a placeholder for kinds they don't know. */
  kind: string;
  /** JSON of the body, encrypted with the node's master key. */
  body: string;
  inReplyTo: string | null;
  /** Empty until the documents module exists. */
  attachments: unknown[];
  transport: 'peer' | 'email' | 'service';
  status: MessageStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  /** When delivery (re)started: the give-up clock. */
  queuedAt: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
};

/** What travels inside the signed envelope to POST /peer/v1/messages. */
export type WireMessage = {
  type: 'message'; id: string; to: string; conversation: string | null; kind: string; body: unknown;
  inReplyTo: string | null; attachments: unknown[]; createdAt: string;
};

const TEXT_MAX = 10_000;
const BODY_JSON_MAX = 20_000;
const GIVE_UP_MS = 3 * 86400_000;
/** First retry delay and outbox tick. The smoke test shortens it. */
const RETRY_BASE_MS = Number(process.env.LD_RETRY_BASE_MS) || 30_000;
/** Refusals that retrying won't fix. Everything else (offline, 5xx) is retried. */
const PERMANENT = new Set(['not_connected', 'not_supported', 'unknown_peer', 'wrong_recipient', 'bad_message', 'message_too_long', 'id_conflict', 'bad_signature']);

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const KIND_RE = /^[a-z][a-z0-9_.]{0,39}$/;

/** Throws unless the body fits its kind. Unknown kinds are accepted, within a size limit. */
export function checkBody(kind: string, body: unknown) {
  if (!KIND_RE.test(kind)) throw bad('bad_message', 'Unknown message kind');
  if (kind === 'text') {
    if (typeof body !== 'string' || !body.trim()) throw bad('bad_message', 'Write a message first');
    if (body.length > TEXT_MAX) throw bad('message_too_long', `Messages can be up to ${TEXT_MAX.toLocaleString()} characters`);
    return;
  }
  if (JSON.stringify(body ?? null).length > BODY_JSON_MAX) throw bad('message_too_long', 'Message is too large');
}

const seal = (body: unknown) => encrypt(ctx.keys.masterKey, JSON.stringify(body));
const unseal = (m: MessageDoc): unknown => JSON.parse(decrypt(ctx.keys.masterKey, m.body));

export function messageOut(m: MessageDoc) {
  return {
    id: m._id, contactId: m.contactId, conversationId: m.conversationId, direction: m.direction, kind: m.kind, body: unseal(m),
    inReplyTo: m.inReplyTo, transport: m.transport, status: m.status, lastError: m.lastError,
    createdAt: m.createdAt, sentAt: m.sentAt, deliveredAt: m.deliveredAt, readAt: m.readAt,
  };
}

// ── sending ─────────────────────────────────────────────────────────────

export async function queueMessage(contact: ContactDoc, kind: string, body: unknown, inReplyTo: string | null) {
  checkBody(kind, body);
  const link = await linkFor(contact);
  if (!link || link.status !== 'active') throw new HttpError(409, 'not_connected', `You can message ${contact.displayName} once you're connected`);
  const t = now();
  const m: MessageDoc = {
    _id: newId('msg'), contactId: contact._id, conversationId: contact._id, direction: 'out', kind, body: seal(body),
    inReplyTo, attachments: [], transport: 'peer', status: 'queued', attempts: 0, nextAttemptAt: t, lastError: null,
    queuedAt: t, createdAt: t, sentAt: null, deliveredAt: null, readAt: null,
  };
  await ctx.store.insert('messages', m);
  await deliver(m._id);
  return (await ctx.store.get<MessageDoc>('messages', m._id))!;
}

/** Peers that advertise the messages capability, cached briefly so a chat doesn't fetch the descriptor every time. */
const capable = new Map<string, { ok: boolean; at: number }>();
async function supportsMessages(link: LinkDoc) {
  const c = capable.get(link._id);
  if (c && Date.now() - c.at < 10 * 60_000) return c.ok;
  const d = await lookupDescriptor(link.peerUrl);
  const ok = Array.isArray(d.capabilities) && d.capabilities.includes('messages');
  capable.set(link._id, { ok, at: Date.now() });
  return ok;
}

const inFlight = new Set<string>();

/** One delivery attempt. Schedules the next one with a growing delay, or gives up. */
export async function deliver(id: string) {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const m = await ctx.store.get<MessageDoc>('messages', id);
    if (!m || m.status !== 'queued') return;
    try {
      const contact = await ctx.store.get<ContactDoc>('contacts', m.contactId);
      const link = contact ? await linkFor(contact) : null;
      if (!link || link.status !== 'active') throw new HttpError(409, 'not_connected', 'No longer connected');
      if (!(await supportsMessages(link))) throw new HttpError(409, 'not_supported', "Their Little Dipper can't receive messages yet");
      const wire: WireMessage = {
        type: 'message', id: m._id, to: link.peerNodeId, conversation: null, kind: m.kind, body: unseal(m),
        inReplyTo: m.inReplyTo, attachments: [], createdAt: m.createdAt,
      };
      await sendSigned(link.peerUrl, '/peer/v1/messages', wire);
      const t = now();
      await ctx.store.update('messages', id, { status: 'delivered', sentAt: t, deliveredAt: t, attempts: m.attempts + 1, nextAttemptAt: null, lastError: null });
    } catch (e) {
      const code = e instanceof HttpError ? e.code : 'peer_unreachable';
      const attempts = m.attempts + 1;
      const expired = Date.now() - new Date(m.queuedAt || m.createdAt).getTime() > GIVE_UP_MS;
      if (PERMANENT.has(code) || expired) {
        await ctx.store.update('messages', id, { status: 'failed', attempts, nextAttemptAt: null, lastError: code });
      } else {
        // 30s, 1m, 2m … capped at 6h.
        const wait = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), 6 * 3600_000);
        await ctx.store.update('messages', id, { attempts, nextAttemptAt: new Date(Date.now() + wait).toISOString(), lastError: code });
      }
    }
  } finally {
    inFlight.delete(id);
  }
}

/** Retry queued messages whose time has come. Started once at boot. */
export function startOutbox() {
  const tick = async () => {
    const due = (await ctx.store.find<MessageDoc>('messages', { status: 'queued' })).filter((m) => !m.nextAttemptAt || m.nextAttemptAt <= now());
    for (const m of due) await deliver(m._id);
  };
  setInterval(() => { tick().catch(() => {}); }, RETRY_BASE_MS).unref();
}

// ── receiving ───────────────────────────────────────────────────────────

/** Store a message a connected peer sent us. Returns duplicate: true when it's a retry we already have. */
export async function receiveMessage(link: LinkDoc, p: WireMessage) {
  if (p.type !== 'message' || p.to !== (await getNode())._id) throw bad('wrong_recipient');
  if (!ID_RE.test(String(p.id))) throw bad('bad_message', 'Bad message id');
  const kind = String(p.kind);
  checkBody(kind, p.body);
  const existing = await ctx.store.get<MessageDoc>('messages', p.id);
  if (existing) {
    if (existing.contactId !== link.contactId || existing.direction !== 'in') throw new HttpError(409, 'id_conflict');
    return { duplicate: true };
  }
  const t = now();
  const inReplyTo = typeof p.inReplyTo === 'string' && ID_RE.test(p.inReplyTo) ? p.inReplyTo : null;
  await ctx.store.insert<MessageDoc>('messages', {
    _id: p.id, contactId: link.contactId, conversationId: link.contactId, direction: 'in', kind, body: seal(p.body),
    inReplyTo, attachments: [], transport: 'peer', status: 'received', attempts: 0, nextAttemptAt: null, lastError: null,
    queuedAt: null, createdAt: t, sentAt: typeof p.createdAt === 'string' ? p.createdAt.slice(0, 40) : null, deliveredAt: t, readAt: null,
  });
  await touch(link.contactId, 'Sent you a message');
  return { duplicate: false };
}
