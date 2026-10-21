/** Endpoints other Little Dippers call. Every write is a signed envelope; reads use the peer token we issued. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ctx } from '../ctx.js';
import { newId, nodeIdFromPublicKey, randomToken, sign } from '../crypto.js';
import { audit } from '../audit.js';
import { bad, findKey, HttpError, rateLimit } from '../auth.js';
import { canonicalUrl, displayAddr, getNode } from '../node.js';
import {
  grantsFor, hasMutual, lookupDescriptor, now, openEnvelope, parsePeerInput, REQUEST_TTL_DAYS, sealToken, tokenHash,
  type ContactDoc, type InviteDoc, type LinkDoc, type PublicProfileDoc, type RequestDoc,
} from '../federation.js';
import { getDomain } from '../domains/records.js';
import { sharedDomainOut } from '../domains/sharing.js';
import { endLink, existingForNode, firstName, issuePeerToken, newNodeContact, pushTimeline, sharedOut, syncContact, touch } from '../contacts.js';
import { receiveMessage, type WireMessage } from '../messages.js';

type Intro = { nodeId: string; address: string; signingKey: string; displayName: string; version?: string };

const peerFrom = (body: unknown) => String((body as { payload?: { from?: string } })?.payload?.from || '');

/** Find the link for the sending node and verify the envelope with the key we stored for it. */
async function verifiedLink<T>(body: unknown, statuses: LinkDoc['status'][]) {
  const from = peerFrom(body);
  const link = (await ctx.store.find<LinkDoc>('nodeLinks', { peerNodeId: from })).find((l) => statuses.includes(l.status));
  if (!link) throw new HttpError(404, 'unknown_peer');
  const payload = openEnvelope<T>(body, link.peerSigningKey);
  return { link, payload };
}

async function signedReply(payload: object) {
  const n = await getNode();
  const p = { ...payload, from: n._id, ts: Date.now(), nonce: randomToken(12) };
  return { payload: p, signature: sign(ctx.keys.signing.privateKey, p) };
}

async function peerContact(req: FastifyRequest) {
  const h = req.headers.authorization;
  const key = await findKey(h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined, ['peer']);
  if (!key?.contactId) throw new HttpError(401, 'bad_peer_token');
  const c = await ctx.store.get<ContactDoc>('contacts', key.contactId);
  if (!c) throw new HttpError(401, 'bad_peer_token');
  return c;
}

export default async function peerRoutes(app: FastifyInstance) {
  app.post('/peer/v1/requests', async (req, reply) => {
    rateLimit(req, 'peer-request', 20, 60 * 60_000);
    const body = req.body as { payload?: { fromNode?: Intro } };
    const intro = body?.payload?.fromNode;
    if (!intro?.signingKey || !intro.nodeId || !intro.address) throw bad('bad_request');
    if (nodeIdFromPublicKey(intro.signingKey) !== intro.nodeId || peerFrom(body) !== intro.nodeId) throw new HttpError(401, 'identity_mismatch');
    const p = openEnvelope<{ type: string; requestId: string; to: string; offeredFields?: string[]; offeredLabels?: string[]; requestedFields?: string[]; note?: string; invite?: string | null; mutualHints?: string[] }>(body, intro.signingKey);
    const n = await getNode();
    if (p.type !== 'connect.request' || p.to !== n._id) throw bad('wrong_recipient');
    if (!n.claimed) throw new HttpError(409, 'unclaimed');
    if ((n.blockedNodeIds || []).includes(intro.nodeId)) throw new HttpError(403, 'not_accepting', "This Little Dipper isn't accepting requests from you");

    // The claimed address must really serve that identity.
    const origin = parsePeerInput(intro.address).origin;
    const d = await lookupDescriptor(origin);
    if (d.nodeId !== intro.nodeId) throw new HttpError(401, 'address_mismatch');

    // Who may ask: an invite always works; otherwise the owner's connectRequests setting.
    let inviteId: string | null = null;
    if (p.invite) {
      const [id, secret] = String(p.invite).split('.');
      const inv = await ctx.store.get<InviteDoc>('invites', id || '');
      if (!inv || inv.tokenHash !== tokenHash(secret || '') || inv.usedByNodeId || new Date(inv.expiresAt).getTime() < Date.now()) {
        throw new HttpError(410, 'invite_invalid', 'That invite link has expired or was already used. Ask for a new one.');
      }
      await ctx.store.update('invites', inv._id, { usedByNodeId: intro.nodeId });
      inviteId = inv._id;
    }
    const pp = await ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
    const policy = pp?.connectRequests || 'off';
    const mutual = await hasMutual(p.mutualHints, n._id);
    if (!inviteId) {
      if (policy === 'off') throw new HttpError(403, 'not_accepting', "This Little Dipper isn't accepting connection requests. Ask its owner for an invite link.");
      if (policy === 'fof' && !mutual) throw new HttpError(403, 'not_accepting', 'This Little Dipper only accepts requests from people its owner\'s contacts know.');
    }
    const quiet = !inviteId && !mutual;

    const existing = await existingForNode(intro.nodeId);
    if (existing?.link.status === 'active') throw new HttpError(409, 'already_connected');
    const requested = (p.requestedFields || []).map(String).slice(0, 50);
    const offered = (p.offeredLabels || []).map(String).slice(0, 50);
    const name = String(intro.displayName || displayAddr(intro.address)).slice(0, 120);
    let contact: ContactDoc, link: LinkDoc;
    if (existing) {
      // Requests crossed (we had asked them too) or a repeat: refresh the pending link.
      ({ contact, link } = existing);
      await ctx.store.update('nodeLinks', link._id, { status: 'pending_in', requestId: p.requestId, peerUrl: origin, peerSigningKey: intro.signingKey });
      await ctx.store.update('contacts', contact._id, { requested, offered, displayName: name });
      await ctx.store.removeMany('connectionRequests', { linkId: link._id, status: 'pending' });
    } else {
      ({ contact, link } = await newNodeContact({ displayName: name, address: origin, nodeId: intro.nodeId, signingKey: intro.signingKey, version: intro.version || null, status: 'pending_in', requestId: p.requestId, offered, requested }));
      // Default if accepted: basic profile only. Requests never pre-select sensitive fields.
      await ctx.store.insert('grants', { _id: newId('grt'), contactId: contact._id, profile: true, access: 'read', confirmedSecret: false, grantedAt: now(), expiresAt: null });
    }
    const t = now();
    await ctx.store.insert<RequestDoc>('connectionRequests', {
      _id: newId('req'), direction: 'in', requestId: p.requestId, fromNodeId: intro.nodeId, peerName: name, fromNode: displayAddr(origin), toNode: displayAddr(canonicalUrl(n)),
      offeredFields: (p.offeredFields || []).map(String), offeredLabels: offered, requestedFields: requested, note: String(p.note || '').slice(0, 500),
      nonce: (body as { payload: { nonce: string } }).payload.nonce, signature: (body as unknown as { signature: string }).signature, inviteId, quiet,
      status: 'pending', contactId: contact._id, linkId: link._id, createdAt: t, expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86400_000).toISOString(),
    });
    await audit({ actor: { type: 'peer', id: intro.nodeId }, action: 'link.request.in', resource: `contacts/${contact._id}`, text: `${name} sent a connection request${inviteId ? ' with your invite link' : ''}`, tone: 'request', ip: req.ip });
    reply.code(202);
    return { received: true };
  });

  app.post('/peer/v1/requests/:requestId/accept', async (req) => {
    const { requestId } = req.params as { requestId: string };
    const { link, payload } = await verifiedLink<{ type: string; requestId: string; token: string; version?: string }>(req.body, ['pending_out']);
    if (payload.type !== 'connect.accept' || payload.requestId !== requestId || link.requestId !== requestId || !payload.token) throw bad('bad_accept');
    const contact = (await ctx.store.get<ContactDoc>('contacts', link.contactId))!;
    const { secret, doc } = await issuePeerToken(contact);
    await ctx.store.update('nodeLinks', link._id, {
      status: 'active', tokenFromPeerEnc: sealToken(payload.token), tokenIssuedToPeer: { keyId: doc._id, scope: 'peer:profile peer:fields' },
      establishedAt: now(), peerVersion: payload.version || link.peerVersion,
    });
    await pushTimeline(link, `Approved by ${firstName(contact.displayName)}`);
    await pushTimeline(link, 'Secure connection set up');
    const r = await ctx.store.findOne<RequestDoc>('connectionRequests', { linkId: link._id, status: 'pending' });
    if (r) await ctx.store.update('connectionRequests', r._id, { status: 'accepted' });
    await touch(contact._id, 'Connected');
    await audit({ actor: { type: 'peer', id: link.peerNodeId }, action: 'link.accept', resource: `contacts/${contact._id}`, text: `${contact.displayName} approved your request`, tone: 'peer' });
    // Fetch what they share once they've stored our token.
    setTimeout(() => { ctx.store.get<ContactDoc>('contacts', contact._id).then((c) => c && syncContact(c)).catch(() => {}); }, 300);
    return signedReply({ type: 'connect.accepted', requestId, token: secret });
  });

  app.post('/peer/v1/requests/:requestId/decline', async (req) => {
    const { requestId } = req.params as { requestId: string };
    const { link, payload } = await verifiedLink<{ type: string; requestId: string }>(req.body, ['pending_out']);
    if (payload.type !== 'connect.decline' || link.requestId !== requestId) throw bad('bad_decline');
    const contact = await ctx.store.get<ContactDoc>('contacts', link.contactId);
    const r = await ctx.store.findOne<RequestDoc>('connectionRequests', { linkId: link._id, status: 'pending' });
    if (r) await ctx.store.update('connectionRequests', r._id, { status: 'declined' });
    await endLink(link, 'Request declined');
    await ctx.store.removeMany('grants', { contactId: link.contactId });
    await audit({ actor: { type: 'peer', id: link.peerNodeId }, action: 'link.declined', resource: `contacts/${link.contactId}`, text: `${contact?.displayName || displayAddr(link.peerUrl)} declined your request`, tone: 'peer' });
    return { ok: true };
  });

  app.post('/peer/v1/links/revoke', async (req) => {
    const { link, payload } = await verifiedLink<{ type: string }>(req.body, ['active', 'pending_out', 'pending_in']);
    if (payload.type !== 'link.revoke') throw bad('bad_revoke');
    const contact = await ctx.store.get<ContactDoc>('contacts', link.contactId);
    await endLink(link, `${contact ? firstName(contact.displayName) : 'They'} disconnected`);
    await audit({ actor: { type: 'peer', id: link.peerNodeId }, action: 'link.revoked', resource: `contacts/${link.contactId}`, text: `${contact?.displayName || displayAddr(link.peerUrl)} disconnected`, tone: 'peer' });
    return { ok: true };
  });

  app.post('/peer/v1/links/rotate', async (req) => {
    const { link, payload } = await verifiedLink<{ type: string; token: string }>(req.body, ['active']);
    if (payload.type !== 'link.rotate' || !payload.token) throw bad('bad_rotate');
    const contact = (await ctx.store.get<ContactDoc>('contacts', link.contactId))!;
    const { secret, doc } = await issuePeerToken(contact);
    if (link.tokenIssuedToPeer) await ctx.store.update('apiKeys', link.tokenIssuedToPeer.keyId, { revokedAt: now() });
    await ctx.store.update('nodeLinks', link._id, { tokenFromPeerEnc: sealToken(payload.token), tokenIssuedToPeer: { keyId: doc._id, scope: 'peer:profile peer:fields' }, rotatedAt: now() });
    await pushTimeline(link, `Connection refreshed by ${firstName(contact.displayName)}`);
    return signedReply({ type: 'link.rotated', token: secret });
  });

  /** Signed nudge: what they share with us changed. Sync now (in the background). */
  app.post('/peer/v1/links/changed', async (req, reply) => {
    const { link, payload } = await verifiedLink<{ type: string }>(req.body, ['active']);
    if (payload.type !== 'link.changed') throw bad('bad_nudge');
    setTimeout(() => { ctx.store.get<ContactDoc>('contacts', link.contactId).then((c) => c && syncContact(c)).catch(() => {}); }, 100);
    reply.code(202);
    return { ok: true };
  });

  /** Signed notice that a peer moved. Verified against the stored key, then peerUrl is updated. */
  app.post('/peer/v1/address-change', async (req, reply) => {
    const { link, payload } = await verifiedLink<{ type: string; nodeId: string; newAddress: string }>(req.body, ['active', 'pending_in', 'pending_out']);
    if (payload.type !== 'address.change' || payload.nodeId !== link.peerNodeId) throw bad('bad_address_change');
    const origin = parsePeerInput(payload.newAddress).origin;
    const d = await lookupDescriptor(origin);
    if (d.nodeId !== link.peerNodeId) throw new HttpError(401, 'address_mismatch');
    await ctx.store.update('nodeLinks', link._id, { peerUrl: origin });
    const c = await ctx.store.get<ContactDoc>('contacts', link.contactId);
    if (c?.node) await ctx.store.update('contacts', c._id, { node: { ...c.node, url: origin } });
    await pushTimeline(link, `Moved to ${displayAddr(origin)}`);
    await audit({ actor: { type: 'peer', id: link.peerNodeId }, action: 'link.address', resource: `nodeLinks/${link._id}`, text: `${c?.displayName || 'A contact'} moved to ${displayAddr(origin)}`, tone: 'peer' });
    reply.code(202);
    return { updated: true };
  });

  /** A message from a connected contact. The sender picks the id, so a retried delivery returns 200 without storing twice. */
  app.post('/peer/v1/messages', async (req, reply) => {
    rateLimit(req, 'peer-message', 600, 60 * 60_000);
    const { link, payload } = await verifiedLink<WireMessage>(req.body, ['active']);
    const r = await receiveMessage(link, payload as WireMessage);
    reply.code(r.duplicate ? 200 : 201);
    return { received: true, id: payload.id, duplicate: r.duplicate };
  });

  /** Basic profile: every Standard field. Granted by default on connect (scope peer:profile). */
  app.get('/peer/v1/profile', async (req) => {
    const c = await peerContact(req);
    const fields = await sharedOut(c._id, 'profile');
    await audit({ actor: { type: 'peer', id: c.node?.nodeId || c._id }, action: 'peer.read', resource: 'peer/profile', text: `${c.displayName}'s Little Dipper read your basic profile`, tone: 'peer', ip: req.ip });
    await touch(c._id, 'Read your basic profile');
    return { fields };
  });

  /** Domains this contact has been granted (employment, residences…). */
  app.get('/peer/v1/domains', async (req) => {
    const c = await peerContact(req);
    const g = await grantsFor(c._id);
    const out = [];
    for (const [id, grant] of Object.entries(g.domains)) {
      const d = await getDomain(id);
      if (d) out.push({ id, label: d.label, scope: grant.scope });
    }
    return { domains: out };
  });

  app.get('/peer/v1/domains/:domain', async (req) => {
    const c = await peerContact(req);
    const { domain } = req.params as { domain: string };
    const shared = await sharedDomainOut(c._id, domain);
    if (!shared) throw new HttpError(403, 'not_granted', 'Not shared with you');
    await audit({ actor: { type: 'peer', id: c.node?.nodeId || c._id }, action: 'domain.read', resource: `peer/domains/${domain}`, text: `${c.displayName}'s Little Dipper read your ${shared.label.toLowerCase()} (${shared.records.length})`, tone: 'peer', ip: req.ip });
    return shared;
  });

  /** Extra fields granted one by one (Sensitive or Secret). Returns only those. */
  app.get('/peer/v1/fields', async (req) => {
    const c = await peerContact(req);
    const fields = await sharedOut(c._id, 'fields');
    if (fields.length) {
      await audit({ actor: { type: 'peer', id: c.node?.nodeId || c._id }, action: 'field.read', resource: 'peer/fields', text: `${c.displayName}'s Little Dipper read your ${fields.map((f) => f.label.toLowerCase()).join(', ')}`, tone: 'peer', ip: req.ip, meta: { keys: fields.map((f) => f.key) } });
    }
    return { fields };
  });
}
