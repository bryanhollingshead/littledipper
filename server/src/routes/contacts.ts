import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { fingerprint, newId, randomToken } from '../crypto.js';
import { audit, ownerActor } from '../audit.js';
import { bad, HttpError, notFound, requireOwner } from '../auth.js';
import { allFields, type FieldDoc } from '../fields.js';
import { getDomain } from '../domains/records.js';
import { canonicalUrl, displayAddr, getNode } from '../node.js';
import { getOwner } from '../owner.js';
import {
  grantsFor, lookupDescriptor, mutualHints, now, parsePeerInput, REQUEST_TTL_DAYS, sealToken, sendSigned, setDomainGrant, setFieldGrant, setProfileGrant, tokenHash,
  type ContactDoc, type InviteDoc, type LinkDoc, type Method, type PublicProfileDoc, type RequestDoc,
} from '../federation.js';
import {
  nudgePeers, contactOut, endLink, existingForNode, firstName, issuePeerToken, linkFor, newNodeContact, pushTimeline, revokeIssuedToken, syncContact, touch,
} from '../contacts.js';

const STALE_MS = 10 * 60_000;

async function getContact(id: string) {
  const c = await ctx.store.get<ContactDoc>('contacts', id);
  if (!c) throw notFound('contact_not_found');
  return c;
}

/** What we tell a peer about ourselves in a request. */
async function selfIntro() {
  const n = await getNode();
  const o = await getOwner();
  const pp = await ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
  return { nodeId: n._id, address: canonicalUrl(n), signingKey: n.signingKey.publicKey, displayName: pp?.displayName || o?.displayName || 'Little Dipper owner', version: n.version };
}

async function labelsFor(keys: string[]) {
  const fields = await allFields();
  return keys.map((k) => fields.find((f) => f.key === k)?.label).filter(Boolean) as string[];
}

async function sendRequest(link: LinkDoc, offeredFields: string[], note: string, invite: string | null) {
  const offeredLabels = [...(await allFields()).filter((f) => f.sensitivity === 'standard' && f.value).map((f) => f.label), ...(await labelsFor(offeredFields))];
  await sendSigned(link.peerUrl, '/peer/v1/requests', {
    type: 'connect.request', requestId: link.requestId, to: link.peerNodeId, fromNode: await selfIntro(),
    offeredFields, offeredLabels, requestedFields: [], note, invite, mutualHints: await mutualHints(link.peerNodeId),
  });
}

export default async function contactRoutes(app: FastifyInstance) {
  // ── contacts ─────────────────────────────────────────────────────────
  app.get('/api/v1/contacts', async (req) => {
    await requireOwner(req, 'contacts:read');
    const q = req.query as { kind?: string; status?: string; q?: string };
    const all = await ctx.store.find<ContactDoc>('contacts', {}, { sort: { createdAt: -1 } });
    const items = await Promise.all(all.map((c) => contactOut(c)));
    const term = (q.q || '').toLowerCase();
    return {
      items: items.filter((c) => (!q.kind || c.kind === q.kind) && (!q.status || c.status === q.status) && (!term || c.displayName.toLowerCase().includes(term) || (c.org || '').toLowerCase().includes(term))),
    };
  });

  app.post('/api/v1/contacts', async (req, reply) => {
    const p = await requireOwner(req, 'contacts:write');
    const b = (req.body || {}) as { displayName?: string; org?: string; email?: string; phone?: string; address?: string; notes?: string; methods?: Method[] };
    const name = String(b.displayName || '').trim();
    if (!name) throw bad('name_required', 'Add a name first');
    const methods: Method[] = b.methods || [
      ...(b.email ? [{ type: 'email' as const, label: 'Email', value: b.email }] : []),
      ...(b.phone ? [{ type: 'phone' as const, label: 'Phone', value: b.phone }] : []),
      ...(b.address ? [{ type: 'address' as const, label: 'Address', value: b.address }] : []),
    ];
    const t = now();
    const c: ContactDoc = {
      _id: newId('con'), kind: 'person', displayName: name, org: b.org?.trim() || null, methods, notes: b.notes || '', node: null,
      sharedIn: [], sharedInFetchedAt: null, requested: [], offered: [], lastActivity: { text: 'Added', at: t }, createdAt: t,
    };
    await ctx.store.insert('contacts', c);
    await audit({ actor: ownerActor(p.key._id), action: 'contact.create', resource: `contacts/${c._id}`, text: `You added ${name}`, tone: 'owner' });
    reply.code(201);
    return contactOut(c, { detail: true });
  });

  app.get('/api/v1/contacts/:id', async (req) => {
    await requireOwner(req, 'contacts:read');
    let c = await getContact((req.params as { id: string }).id);
    const link = await linkFor(c);
    let syncError: string | null = null;
    const stale = !c.sharedInFetchedAt || Date.now() - new Date(c.sharedInFetchedAt).getTime() > STALE_MS;
    if (link?.status === 'active' && (stale || (req.query as { sync?: string }).sync)) {
      try { c = await syncContact(c); } catch (e) { syncError = (e as Error).message; }
    }
    return { ...(await contactOut(c, { detail: true })), syncError };
  });

  app.patch('/api/v1/contacts/:id', async (req) => {
    const p = await requireOwner(req, 'contacts:write');
    const c = await getContact((req.params as { id: string }).id);
    const b = (req.body || {}) as { displayName?: string; org?: string; notes?: string; methods?: Method[] };
    const patch: Record<string, unknown> = {};
    if (b.displayName?.trim()) patch.displayName = b.displayName.trim();
    if (b.org !== undefined) patch.org = b.org || null;
    if (b.notes !== undefined) patch.notes = b.notes;
    if (Array.isArray(b.methods)) patch.methods = b.methods.filter((m) => m?.value).map((m) => ({ type: m.type, label: String(m.label), value: String(m.value) }));
    patch.lastActivity = { text: 'Edited', at: now() };
    await ctx.store.update('contacts', c._id, patch);
    await audit({ actor: ownerActor(p.key._id), action: 'contact.update', resource: `contacts/${c._id}`, text: `You edited ${c.displayName}`, tone: 'owner' });
    return contactOut((await ctx.store.get<ContactDoc>('contacts', c._id))!, { detail: true });
  });

  app.delete('/api/v1/contacts/:id', async (req) => {
    const p = await requireOwner(req, 'contacts:write');
    const c = await getContact((req.params as { id: string }).id);
    const link = await linkFor(c);
    if (link && link.status === 'active') {
      try { await sendSigned(link.peerUrl, '/peer/v1/links/revoke', { type: 'link.revoke' }); } catch { /* peer offline: our side still revokes */ }
    }
    if (link) { await revokeIssuedToken(link); await ctx.store.remove('nodeLinks', link._id); }
    await ctx.store.removeMany('grants', { contactId: c._id });
    await ctx.store.removeMany('connectionRequests', { contactId: c._id });
    await ctx.store.remove('contacts', c._id);
    await audit({ actor: ownerActor(p.key._id), action: 'contact.delete', resource: `contacts/${c._id}`, text: `You deleted ${c.displayName}`, tone: 'owner' });
    return { deleted: true };
  });

  app.get('/api/v1/contacts/:id/grants', async (req) => {
    await requireOwner(req, 'contacts:read');
    const c = await getContact((req.params as { id: string }).id);
    const g = await grantsFor(c._id);
    return { profile: g.profile, fields: g.fields };
  });

  /**
   * Body: { profile?: boolean, fields?: { [key]: boolean }, domains?: { [domain]: false | true | { scope?: 'all'|'current', includeSecret?: boolean } }, confirm?: boolean }
   * Secret fields, secret domains and includeSecret need confirm:true.
   */
  app.put('/api/v1/contacts/:id/grants', async (req) => {
    const p = await requireOwner(req, 'contacts:write');
    const c = await getContact((req.params as { id: string }).id);
    if (c.kind !== 'node') throw bad('not_connected', 'Only contacts on Little Dipper can be granted access');
    const b = (req.body || {}) as { profile?: boolean; fields?: Record<string, boolean>; domains?: Record<string, boolean | { scope?: 'all' | 'current'; includeSecret?: boolean }>; confirm?: boolean };
    const fields = await allFields();
    const changes: string[] = [];
    if (typeof b.profile === 'boolean') {
      await setProfileGrant(c._id, b.profile);
      changes.push(`basic profile ${b.profile ? 'on' : 'off'}`);
    }
    for (const [key, on] of Object.entries(b.fields || {})) {
      const f = fields.find((x) => x.key === key) as FieldDoc | undefined;
      if (!f) throw bad('unknown_field', key);
      if (on && f.sensitivity === 'secret' && b.confirm !== true) throw new HttpError(409, 'confirm_required', `Sharing ${f.label} needs confirmation`);
      await setFieldGrant(c._id, key, !!on, f.sensitivity === 'secret');
      changes.push(`${f.label} ${on ? 'shared' : 'unshared'}`);
    }
    for (const [id, v] of Object.entries(b.domains || {})) {
      const d = await getDomain(id);
      if (!d) throw bad('unknown_domain', id);
      if (!v) {
        await setDomainGrant(c._id, id, null);
        changes.push(`${d.label} unshared`);
        continue;
      }
      const g = v === true ? {} : v;
      const scope = g.scope === 'current' ? 'current' : 'all';
      const includeSecret = !!g.includeSecret;
      if ((d.sensitivity === 'secret' || includeSecret) && b.confirm !== true) throw new HttpError(409, 'confirm_required', `Sharing ${d.label} needs confirmation`);
      await setDomainGrant(c._id, id, { scope, includeSecret });
      changes.push(`${d.label} shared (${scope === 'current' ? 'current only' : 'all'}${includeSecret ? ', with secret details' : ''})`);
    }
    if (changes.length) {
      await audit({ actor: ownerActor(p.key._id), action: 'grant.update', resource: `contacts/${c._id}/grants`, text: `Sharing with ${c.displayName}: ${changes.join(', ')}`, tone: 'owner' });
    }
    if (changes.length) nudgePeers([c._id]);
    const g = await grantsFor(c._id);
    return { profile: g.profile, fields: g.fields, domains: g.domains };
  });

  app.post('/api/v1/contacts/:id/invite', async (req) => {
    await requireOwner(req, 'contacts:write');
    const c = await getContact((req.params as { id: string }).id);
    const inv = await createInvite('7d', []);
    const n = await getNode();
    const email = c.methods.find((m) => m.type === 'email')?.value || '';
    const o = await getOwner();
    const body = `Hi ${firstName(c.displayName)},\n\nI keep my contact details on Little Dipper, a personal data store I run myself. If you set one up too, open this link in it and we'll be connected:\n\n${inv.url}\n\nDon't have one yet? It's free and open source.\n\n${o?.displayName || ''}`;
    return { ...inv, to: email, subject: 'Connect with me on Little Dipper', body, address: displayAddr(canonicalUrl(n)) };
  });

  // ── federation (owner side) ──────────────────────────────────────────
  app.post('/api/v1/federation/lookup', async (req) => {
    await requireOwner(req, 'contacts:write');
    const { address } = (req.body || {}) as { address?: string };
    const { origin, invite } = parsePeerInput(String(address || ''));
    const d = await lookupDescriptor(origin);
    const n = await getNode();
    if (d.nodeId === n._id) throw bad('self', "That's your own Little Dipper");
    const existing = await existingForNode(d.nodeId);
    return {
      nodeId: d.nodeId, displayName: d.displayName, address: displayAddr(d.address), version: d.version,
      signingKey: fingerprint(d.signingKey),
      viaInvite: !!invite, acceptsRequests: !!invite || d.connectRequests !== 'off',
      existing: existing ? { contactId: existing.contact._id, status: existing.link.status } : null,
    };
  });

  app.post('/api/v1/federation/requests', async (req, reply) => {
    const p = await requireOwner(req, 'contacts:write');
    const b = (req.body || {}) as { address?: string; offeredFields?: string[]; note?: string };
    const { origin, invite } = parsePeerInput(String(b.address || ''));
    const d = await lookupDescriptor(origin);
    const n = await getNode();
    if (d.nodeId === n._id) throw bad('self', "That's your own Little Dipper");
    const existing = await existingForNode(d.nodeId);
    if (existing && existing.link.status === 'active') throw new HttpError(409, 'already_connected', `You're already connected with ${existing.contact.displayName}`);
    if (existing && existing.link.status === 'pending_in') throw new HttpError(409, 'request_waiting', `${existing.contact.displayName} already asked to connect. Review their request instead.`);
    if (existing) throw new HttpError(409, 'request_pending', `You already asked ${existing.contact.displayName}. Use Resend on their contact page.`);
    const fields = await allFields();
    const offered = (b.offeredFields || []).filter((k) => fields.some((f) => f.key === k && f.sensitivity === 'sensitive'));
    const requestId = newId('req');
    const name = d.displayName || displayAddr(d.address);
    const { contact, link } = await newNodeContact({ displayName: name, address: d.address, nodeId: d.nodeId, signingKey: d.signingKey, version: d.version, status: 'pending_out', requestId });
    try {
      await sendRequest(link, offered, String(b.note || '').slice(0, 500), invite);
    } catch (e) {
      await ctx.store.remove('contacts', contact._id);
      await ctx.store.remove('nodeLinks', link._id);
      throw e;
    }
    // What we'll share once they approve: basic profile + the extras we offered.
    await setProfileGrant(contact._id, true);
    for (const k of offered) await setFieldGrant(contact._id, k, true);
    const t = now();
    await ctx.store.insert<RequestDoc>('connectionRequests', {
      _id: newId('req'), direction: 'out', requestId, fromNodeId: n._id, peerName: name, fromNode: displayAddr(canonicalUrl(n)), toNode: displayAddr(d.address),
      offeredFields: offered, offeredLabels: [], requestedFields: [], note: String(b.note || ''), nonce: randomToken(8), signature: '', inviteId: null,
      quiet: false, status: 'pending', contactId: contact._id, linkId: link._id, createdAt: t, expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86400_000).toISOString(),
    });
    await audit({ actor: ownerActor(p.key._id), action: 'link.request.out', resource: `contacts/${contact._id}`, text: `You sent ${name} a connection request`, tone: 'request' });
    reply.code(202);
    return { delivered: true, contactId: contact._id, requestId };
  });

  app.get('/api/v1/federation/requests', async (req) => {
    await requireOwner(req, 'contacts:read');
    const q = req.query as { status?: string; direction?: string };
    for (const r of await ctx.store.find<RequestDoc>('connectionRequests', { status: 'pending' })) {
      if (new Date(r.expiresAt).getTime() < Date.now()) await ctx.store.update('connectionRequests', r._id, { status: 'expired' });
    }
    const items = await ctx.store.find<RequestDoc>('connectionRequests', { ...(q.status ? { status: q.status } : {}), ...(q.direction ? { direction: q.direction } : {}) }, { sort: { createdAt: -1 } });
    return { items: items.map(({ signature, nonce, ...r }) => r) };
  });

  app.post('/api/v1/federation/requests/:id/resend', async (req) => {
    await requireOwner(req, 'contacts:write');
    const r = await ctx.store.get<RequestDoc>('connectionRequests', (req.params as { id: string }).id);
    if (!r || r.direction !== 'out' || r.status !== 'pending') throw notFound('request_not_found');
    const link = (await ctx.store.get<LinkDoc>('nodeLinks', r.linkId))!;
    await sendRequest(link, r.offeredFields, r.note, null);
    await ctx.store.update('connectionRequests', r._id, { expiresAt: new Date(Date.now() + REQUEST_TTL_DAYS * 86400_000).toISOString() });
    return { delivered: true };
  });

  app.post('/api/v1/federation/requests/:id/accept', async (req) => {
    const p = await requireOwner(req, 'contacts:write');
    const r = await ctx.store.get<RequestDoc>('connectionRequests', (req.params as { id: string }).id);
    if (!r || r.direction !== 'in' || r.status !== 'pending') throw notFound('request_not_found');
    const link = (await ctx.store.get<LinkDoc>('nodeLinks', r.linkId))!;
    const contact = (await ctx.store.get<ContactDoc>('contacts', r.contactId))!;
    const { secret, doc } = await issuePeerToken(contact);
    let theirs: { token?: string };
    try {
      theirs = await sendSigned(link.peerUrl, `/peer/v1/requests/${encodeURIComponent(r.requestId)}/accept`, { type: 'connect.accept', requestId: r.requestId, token: secret, version: (await getNode()).version }, link.peerSigningKey);
    } catch (e) {
      await ctx.store.update('apiKeys', doc._id, { revokedAt: now() });
      throw e;
    }
    if (!theirs.token) throw new HttpError(502, 'peer_error', "Their Little Dipper didn't send a token back");
    const t = now();
    await ctx.store.update('nodeLinks', link._id, { status: 'active', tokenIssuedToPeer: { keyId: doc._id, scope: 'peer:profile peer:fields' }, tokenFromPeerEnc: sealToken(theirs.token), establishedAt: t });
    await pushTimeline(link, 'Approved by you');
    await pushTimeline(link, 'Secure connection set up');
    await ctx.store.update('connectionRequests', r._id, { status: 'accepted' });
    await touch(contact._id, 'Connected');
    const g = await grantsFor(contact._id);
    await audit({ actor: ownerActor(p.key._id), action: 'link.accept', resource: `contacts/${contact._id}`, text: `You connected with ${contact.displayName}`, tone: 'peer', meta: { grants: g } });
    try { await syncContact((await ctx.store.get<ContactDoc>('contacts', contact._id))!); } catch { /* fetched later */ }
    return { status: 'active', grants: { profile: g.profile, fields: g.fields, domains: g.domains }, issuedToken: doc.prefix };
  });

  app.post('/api/v1/federation/requests/:id/decline', async (req) => {
    const p = await requireOwner(req, 'contacts:write');
    const r = await ctx.store.get<RequestDoc>('connectionRequests', (req.params as { id: string }).id);
    if (!r || r.direction !== 'in' || r.status !== 'pending') throw notFound('request_not_found');
    const link = await ctx.store.get<LinkDoc>('nodeLinks', r.linkId);
    const contact = await ctx.store.get<ContactDoc>('contacts', r.contactId);
    if (link) {
      try { await sendSigned(link.peerUrl, `/peer/v1/requests/${encodeURIComponent(r.requestId)}/decline`, { type: 'connect.decline', requestId: r.requestId }); } catch { /* best effort */ }
    }
    const { block } = (req.body || {}) as { block?: boolean };
    if (block) {
      const n = await getNode();
      await ctx.store.update('nodes', n._id, { blockedNodeIds: [...new Set([...(n.blockedNodeIds || []), r.fromNodeId])] });
    }
    // Declined strangers don't linger in the address book.
    if (contact) await ctx.store.remove('contacts', contact._id);
    if (link) await ctx.store.remove('nodeLinks', link._id);
    await ctx.store.removeMany('grants', { contactId: r.contactId });
    await ctx.store.update('connectionRequests', r._id, { status: 'declined' });
    await audit({ actor: ownerActor(p.key._id), action: 'link.decline', resource: `connectionRequests/${r._id}`, text: `You declined ${contact?.displayName || r.fromNode}'s request${block ? ' and blocked them' : ''}`, tone: 'owner' });
    return { status: 'declined' };
  });

  // ── invites ──────────────────────────────────────────────────────────
  async function createInvite(expiresIn: string, offeredFields: string[]) {
    const ttl = { '24h': 1, '7d': 7, '30d': 30 }[expiresIn] ?? 7;
    const id = 'inv_' + randomToken(6).replace(/[-_]/g, 'x');
    const secret = randomToken(12);
    const doc: InviteDoc = { _id: id, tokenHash: tokenHash(secret), offeredFields, singleUse: true, expiresAt: new Date(Date.now() + ttl * 86400_000).toISOString(), usedByNodeId: null, createdAt: now() };
    await ctx.store.insert('invites', doc);
    const n = await getNode();
    return { id, url: `${canonicalUrl(n)}/connect?invite=${id}.${secret}`, expiresAt: doc.expiresAt, singleUse: true, offeredFields };
  }

  app.post('/api/v1/federation/invites', async (req, reply) => {
    const p = await requireOwner(req, 'contacts:write');
    const b = (req.body || {}) as { expiresIn?: string; offeredFields?: string[] };
    const fields = await allFields();
    const offered = (b.offeredFields || []).filter((k) => fields.some((f) => f.key === k && f.sensitivity === 'sensitive'));
    const inv = await createInvite(String(b.expiresIn || '7d'), offered);
    await audit({ actor: ownerActor(p.key._id), action: 'invite.create', resource: `invites/${inv.id}`, text: 'You created an invite link', tone: 'owner' });
    reply.code(201);
    return inv;
  });

  // ── links ────────────────────────────────────────────────────────────
  app.post('/api/v1/federation/links/:id/rotate', async (req) => {
    const p = await requireOwner(req, 'contacts:write');
    const link = await ctx.store.get<LinkDoc>('nodeLinks', (req.params as { id: string }).id);
    if (!link || link.status !== 'active') throw notFound('link_not_found');
    const contact = (await ctx.store.get<ContactDoc>('contacts', link.contactId))!;
    const { secret, doc } = await issuePeerToken(contact);
    let theirs: { token?: string };
    try {
      theirs = await sendSigned(link.peerUrl, '/peer/v1/links/rotate', { type: 'link.rotate', token: secret }, link.peerSigningKey);
    } catch (e) {
      await ctx.store.update('apiKeys', doc._id, { revokedAt: now() });
      throw e;
    }
    if (!theirs.token) throw new HttpError(502, 'peer_error', "Their Little Dipper didn't send a new token");
    await revokeIssuedToken(link);
    await ctx.store.update('nodeLinks', link._id, { tokenIssuedToPeer: { keyId: doc._id, scope: 'peer:profile peer:fields' }, tokenFromPeerEnc: sealToken(theirs.token), rotatedAt: now() });
    await pushTimeline(link, 'Connection refreshed');
    await audit({ actor: ownerActor(p.key._id), action: 'link.rotate', resource: `nodeLinks/${link._id}`, text: `You refreshed the connection with ${contact.displayName}`, tone: 'owner' });
    return { rotated: true, newTokenPrefix: doc.prefix };
  });

  app.delete('/api/v1/federation/links/:id', async (req) => {
    const p = await requireOwner(req, 'contacts:write');
    const link = await ctx.store.get<LinkDoc>('nodeLinks', (req.params as { id: string }).id);
    if (!link || link.status === 'revoked') throw notFound('link_not_found');
    const contact = await ctx.store.get<ContactDoc>('contacts', link.contactId);
    let notified = true;
    try { await sendSigned(link.peerUrl, '/peer/v1/links/revoke', { type: 'link.revoke' }); } catch { notified = false; }
    await endLink(link, 'Disconnected');
    await audit({ actor: ownerActor(p.key._id), action: 'link.revoke', resource: `nodeLinks/${link._id}`, text: `You disconnected from ${contact?.displayName || displayAddr(link.peerUrl)}`, tone: 'owner' });
    return { status: 'revoked', peerNotified: notified };
  });
}
