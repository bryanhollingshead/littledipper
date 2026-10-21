/** Owner inbox: conversations by contact, sending, read state. Peers deliver to POST /peer/v1/messages (routes/peer.ts). */
import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { notFound, requireOwner } from '../auth.js';
import { now, type ContactDoc } from '../federation.js';
import { contactOut } from '../contacts.js';
import { deliver, messageOut, queueMessage, type MessageDoc } from '../messages.js';

async function getContact(id: string) {
  const c = await ctx.store.get<ContactDoc>('contacts', id);
  if (!c) throw notFound('contact_not_found');
  return c;
}

const preview = (m: MessageDoc) => {
  const o = messageOut(m);
  return o.kind === 'text' ? String(o.body).slice(0, 140) : `[${o.kind}]`;
};

export default async function messageRoutes(app: FastifyInstance) {
  app.get('/api/v1/messages/unread', async (req) => {
    await requireOwner(req, 'messages:read');
    return { count: await ctx.store.count('messages', { direction: 'in', status: 'received' }) };
  });

  /** One row per contact you've exchanged messages with, newest first. */
  app.get('/api/v1/messages/conversations', async (req) => {
    await requireOwner(req, 'messages:read');
    const all = await ctx.store.find<MessageDoc>('messages', {}, { sort: { createdAt: -1 } });
    const byContact = new Map<string, MessageDoc[]>();
    for (const m of all) byContact.set(m.contactId, [...(byContact.get(m.contactId) || []), m]);
    const items = [];
    for (const [contactId, msgs] of byContact) {
      const c = await ctx.store.get<ContactDoc>('contacts', contactId);
      if (!c) continue;
      const out = await contactOut(c);
      items.push({
        contact: { id: out.id, displayName: out.displayName, kind: out.kind, status: out.status, node: out.node },
        last: { id: msgs[0]._id, direction: msgs[0].direction, kind: msgs[0].kind, preview: preview(msgs[0]), status: msgs[0].status, at: msgs[0].createdAt },
        unread: msgs.filter((m) => m.direction === 'in' && m.status === 'received').length,
        canMessage: out.status === 'active',
      });
    }
    return { items };
  });

  /** Messages with one contact, oldest first. ?before=<iso>&limit=<n> pages back through history. */
  app.get('/api/v1/messages/conversations/:contactId', async (req) => {
    await requireOwner(req, 'messages:read');
    const c = await getContact((req.params as { contactId: string }).contactId);
    const q = req.query as { before?: string; limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500);
    const msgs = (await ctx.store.find<MessageDoc>('messages', { contactId: c._id }, { sort: { createdAt: -1 } }))
      .filter((m) => !q.before || m.createdAt < q.before)
      .slice(0, limit)
      .reverse();
    const out = await contactOut(c);
    return {
      contact: { id: out.id, displayName: out.displayName, kind: out.kind, status: out.status, node: out.node },
      canMessage: out.status === 'active',
      items: msgs.map(messageOut),
    };
  });

  app.post('/api/v1/messages/conversations/:contactId', async (req, reply) => {
    await requireOwner(req, 'messages:write');
    const c = await getContact((req.params as { contactId: string }).contactId);
    const b = (req.body || {}) as { kind?: string; body?: unknown; inReplyTo?: string | null };
    const m = await queueMessage(c, b.kind || 'text', typeof b.body === 'string' ? b.body.trim() : b.body, b.inReplyTo || null);
    reply.code(201);
    return messageOut(m);
  });

  app.post('/api/v1/messages/conversations/:contactId/read', async (req) => {
    await requireOwner(req, 'messages:write');
    const c = await getContact((req.params as { contactId: string }).contactId);
    const unread = await ctx.store.find<MessageDoc>('messages', { contactId: c._id, direction: 'in', status: 'received' });
    const t = now();
    for (const m of unread) await ctx.store.update('messages', m._id, { status: 'read', readAt: t });
    return { read: unread.length };
  });

  /** Try a failed message again (for example after reconnecting). */
  app.post('/api/v1/messages/:id/retry', async (req) => {
    await requireOwner(req, 'messages:write');
    const m = await ctx.store.get<MessageDoc>('messages', (req.params as { id: string }).id);
    if (!m || m.direction !== 'out') throw notFound('message_not_found');
    if (m.status === 'failed') {
      // A fresh start: the give-up clock counts from now.
      await ctx.store.update('messages', m._id, { status: 'queued', attempts: 0, nextAttemptAt: now(), lastError: null, queuedAt: now() });
      await deliver(m._id);
    }
    return messageOut((await ctx.store.get<MessageDoc>('messages', m._id))!);
  });
}
