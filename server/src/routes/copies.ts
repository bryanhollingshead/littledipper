/**
 * Copies of entries for people without a Little Dipper: a snapshot sent as an expiring link,
 * a file to attach (PDF, JSON, text) or text in the email. Sending to an email adds them as a contact.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit, ownerActor } from '../audit.js';
import { bad, HttpError, notFound, rateLimit, requireSession } from '../auth.js';
import { ctx } from '../ctx.js';
import { newId, randomToken, safeEqual, sha256 } from '../crypto.js';
import { touch } from '../contacts.js';
import { canonicalUrl, getNode } from '../node.js';
import { getOwner } from '../owner.js';
import {
  asText, copyOut, DELIVERIES, emailFor, fileName, FORMATS, LINK_HOURS, linkActive, longDate, recipient, render, snapshotOf, takeSnapshot, titleFor,
  type CopyDoc, type Delivery, type Format,
} from '../copies.js';

type CreateBody = {
  items?: unknown; confirm?: boolean; delivery?: Delivery; hours?: number; note?: string; title?: string;
  to?: { contactId?: string; email?: string; name?: string };
};

const ownerName = async () => (await getOwner())?.displayName ?? '';
const meta = async (c: CopyDoc) => ({ title: c.title, sharedBy: await ownerName(), createdAt: c.createdAt, note: c.note });

function formatOf(req: FastifyRequest): Format {
  const f = String((req.query as { format?: string }).format || 'pdf');
  if (!(f in FORMATS)) throw bad('invalid_value', 'format: pdf, json or txt');
  return f as Format;
}

async function sendCopy(reply: FastifyReply, c: CopyDoc, format: Format) {
  reply.header('content-type', FORMATS[format]);
  reply.header('content-disposition', `attachment; filename="${fileName(c.title, c.createdAt, format)}"`);
  reply.header('x-content-type-options', 'nosniff');
  return reply.send(render(format, await meta(c), snapshotOf(c)));
}

export default async function copyRoutes(app: FastifyInstance) {
  // Owner's browser only, like share links: sending data out is an outward-facing act.
  app.get('/api/v1/copies', async (req) => {
    await requireSession(req);
    const q = req.query as { contactId?: string; domain?: string };
    let all = await ctx.store.find<CopyDoc>('copies', {}, { sort: { createdAt: -1 } });
    if (q.contactId) all = all.filter((c) => c.contactId === q.contactId);
    if (q.domain) all = all.filter((c) => c.items.some((i) => i.domain === q.domain));
    return { items: await Promise.all(all.map(copyOut)) };
  });

  /** Take the snapshot; make the link; find or add the contact; write the email for the owner's mail app. */
  app.post('/api/v1/copies', async (req, reply) => {
    const p = await requireSession(req);
    const b = (req.body || {}) as CreateBody;
    const delivery = b.delivery ?? 'link';
    if (!DELIVERIES.includes(delivery)) throw bad('invalid_value', `delivery: ${DELIVERIES.join(', ')}`);
    const hours = Number(b.hours ?? 24 * 7);
    if (delivery === 'link' && !LINK_HOURS.includes(hours)) throw bad('invalid_value', `hours: one of ${LINK_HOURS.join(', ')} (0 = until you turn it off)`);
    const { items, snapshot, snapshotEnc } = await takeSnapshot(b.items, b.confirm === true);
    const to = await recipient(b.to);
    const secret = delivery === 'link' ? randomToken() : null;
    const t = new Date().toISOString();
    const copy: CopyDoc = {
      _id: newId('cpy'), title: String(b.title || '').trim().slice(0, 120) || titleFor(snapshot), items, snapshotEnc, note: String(b.note || '').trim().slice(0, 1000), delivery,
      contactId: to.contact?._id ?? null, sentTo: to.email, tokenHash: secret ? sha256(secret) : null,
      expiresAt: secret && hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null, revokedAt: null, views: 0, downloads: 0, lastViewedAt: null, createdAt: t,
    };
    await ctx.store.insert('copies', copy);
    const url = secret ? `${canonicalUrl(await getNode())}/c/${copy._id}.${secret}` : null;
    const who = to.contact?.displayName;
    const how = delivery === 'link' ? (copy.expiresAt ? `a link until ${longDate(copy.expiresAt)}` : 'a link with no end date') : delivery === 'file' ? 'a file' : 'text in an email';
    if (to.created) await audit({ actor: ownerActor(p.key._id), action: 'contact.create', resource: `contacts/${to.contact!._id}`, text: `You added ${who} when sending a copy`, tone: 'owner' });
    if (to.contact) await touch(to.contact._id, `You sent a copy of ${copy.title}`);
    await audit({ actor: ownerActor(p.key._id), action: 'copy.create', resource: `copies/${copy._id}`, text: `You made a copy of ${copy.title}${who ? ` for ${who}` : ''} as ${how}`, tone: 'owner' });
    const owner = await ownerName();
    reply.code(201);
    return {
      copy: await copyOut(copy), url,
      contact: to.contact ? { id: to.contact._id, displayName: to.contact.displayName, created: to.created } : null,
      email: emailFor({ to: to.email, name: to.contact?.displayName ?? null, owner, title: copy.title, delivery, url, expiresAt: copy.expiresAt, note: copy.note, text: asText({ title: copy.title, sharedBy: owner, createdAt: t, note: '' }, snapshot) }),
    };
  });

  app.get('/api/v1/copies/:id', async (req) => {
    await requireSession(req);
    const c = await ctx.store.get<CopyDoc>('copies', (req.params as { id: string }).id);
    if (!c) throw notFound('copy_not_found');
    return { ...(await copyOut(c)), snapshot: snapshotOf(c) };
  });

  /** The owner's own download, to attach to an email. */
  app.get('/api/v1/copies/:id/download', async (req, reply) => {
    await requireSession(req);
    const c = await ctx.store.get<CopyDoc>('copies', (req.params as { id: string }).id);
    if (!c) throw notFound('copy_not_found');
    return sendCopy(reply, c, formatOf(req));
  });

  /** Turn the link off. ?forget=1 also deletes the copy from your history. */
  app.delete('/api/v1/copies/:id', async (req) => {
    const p = await requireSession(req);
    const c = await ctx.store.get<CopyDoc>('copies', (req.params as { id: string }).id);
    if (!c) throw notFound('copy_not_found');
    const forget = (req.query as { forget?: string }).forget === '1';
    if (forget) await ctx.store.remove('copies', c._id);
    else if (c.tokenHash && !c.revokedAt) await ctx.store.update('copies', c._id, { revokedAt: new Date().toISOString() });
    await audit({ actor: ownerActor(p.key._id), action: forget ? 'copy.delete' : 'copy.revoke', resource: `copies/${c._id}`, text: forget ? `You deleted the copy of ${c.title}` : `You turned off the link to ${c.title}`, tone: 'owner' });
    return forget ? { deleted: true } : { revoked: true };
  });

  // ── what the person with the link sees ───────────────────────────────
  const openCopy = async (req: FastifyRequest) => {
    rateLimit(req, 'copy-view', 300, 10 * 60_000);
    const [id, secret] = String((req.params as { token: string }).token).split('.');
    const c = await ctx.store.get<CopyDoc>('copies', id || '');
    if (!c || !secret || !c.tokenHash || !safeEqual(c.tokenHash, sha256(secret)) || !linkActive(c)) throw new HttpError(404, 'copy_unavailable', 'This link has expired or was turned off');
    return c;
  };

  app.get('/public/v1/copies/:token', async (req, reply) => {
    const c = await openCopy(req);
    await ctx.store.update('copies', c._id, { views: c.views + 1, lastViewedAt: new Date().toISOString() });
    await audit({ actor: { type: 'public', id: c._id }, action: 'copy.view', resource: `copies/${c._id}`, text: `Someone opened your copy of ${c.title}`, tone: 'system', ip: req.ip });
    reply.header('x-robots-tag', 'noindex');
    reply.header('cache-control', 'private, no-store');
    return { title: c.title, note: c.note, sharedBy: await ownerName(), createdAt: c.createdAt, expiresAt: c.expiresAt, categories: snapshotOf(c).map(({ scope, ...s }) => s) };
  });

  app.get('/public/v1/copies/:token/download', async (req, reply) => {
    const c = await openCopy(req);
    const format = formatOf(req);
    await ctx.store.update('copies', c._id, { downloads: c.downloads + 1 });
    await audit({ actor: { type: 'public', id: c._id }, action: 'copy.download', resource: `copies/${c._id}`, text: `Someone saved your copy of ${c.title} (${format.toUpperCase()})`, tone: 'system', ip: req.ip });
    reply.header('x-robots-tag', 'noindex');
    reply.header('cache-control', 'private, no-store');
    return sendCopy(reply, c, format);
  });
}
