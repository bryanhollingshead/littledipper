/** Contact + connection helpers shared by the owner API and the peer API. */
import { ctx } from './ctx.js';
import { fingerprint, newId } from './crypto.js';
import { issueKey } from './auth.js';
import { allFields, plainValue } from './fields.js';
import type { SharedDomain } from './domains/sharing.js';
import { displayAddr } from './node.js';
import {
  grantsFor, now, peerGet, sendSigned, type ContactDoc, type LinkDoc, type Method, type RequestDoc,
} from './federation.js';

export const firstName = (name: string) => name.replace(/^(Dr|Mr|Mrs|Ms|Mx)\.?\s+/i, '').split(' ')[0];

export async function linkFor(c: ContactDoc) {
  return c.node?.linkId ? ctx.store.get<LinkDoc>('nodeLinks', c.node.linkId) : null;
}

export type ContactStatus = 'plain' | 'pending_in' | 'pending_out' | 'active';

export async function contactOut(c: ContactDoc, opts: { detail?: boolean } = {}) {
  const link = await linkFor(c);
  const status: ContactStatus = c.kind === 'node' && link && link.status !== 'revoked' ? link.status : 'plain';
  const g = await grantsFor(c._id);
  const base = {
    id: c._id, kind: c.kind, displayName: c.displayName, org: c.org, status,
    node: c.node && link ? { url: displayAddr(link.peerUrl), nodeId: link.peerNodeId, linkId: link._id } : null,
    grants: { profile: g.profile, fields: g.fields, domains: g.domains },
    lastActivity: c.lastActivity, createdAt: c.createdAt,
    methods: c.methods,
  };
  if (!opts.detail) return base;
  const req = link ? await ctx.store.findOne<RequestDoc>('connectionRequests', { linkId: link._id, status: 'pending' }) : null;
  const issued = link?.tokenIssuedToPeer ? await ctx.store.get('apiKeys', link.tokenIssuedToPeer.keyId) : null;
  return {
    ...base,
    notes: c.notes,
    requested: c.requested || [],
    offered: c.offered || [],
    sharedIn: status === 'active' ? c.sharedIn : [],
    sharedDomains: status === 'active' ? c.sharedDomains || [] : [],
    sharedInFetchedAt: c.sharedInFetchedAt,
    request: req ? { id: req._id, direction: req.direction, note: req.note, quiet: req.quiet, viaInvite: !!req.inviteId, expiresAt: req.expiresAt, requestedFields: req.requestedFields } : null,
    timeline: link?.timeline || [],
    keys: link ? {
      peerSigningKey: fingerprint(link.peerSigningKey),
      peerVersion: link.peerVersion,
      tokenIssued: issued && !issued.revokedAt ? { prefix: issued.prefix, scopes: issued.scopes, lastUsedAt: issued.lastUsedAt } : null,
      tokenFromPeer: link.tokenFromPeerEnc ? { stored: true, lastUsedAt: link.tokenFromPeerLastUsedAt } : null,
      lastSyncAt: link.lastSyncAt, rotatedAt: link.rotatedAt,
    } : null,
  };
}

export async function touch(contactId: string, text: string) {
  await ctx.store.update('contacts', contactId, { lastActivity: { text, at: now() } });
}

export async function pushTimeline(link: LinkDoc, label: string) {
  const fresh = (await ctx.store.get<LinkDoc>('nodeLinks', link._id))!;
  await ctx.store.update('nodeLinks', link._id, { timeline: [...fresh.timeline, { label, at: now() }] });
}

/** Token we hand a peer so it can read what we share. */
export async function issuePeerToken(contact: ContactDoc) {
  return issueKey({ kind: 'peer', name: contact.displayName, scopes: ['peer:profile', 'peer:fields'], contactId: contact._id });
}

export async function revokeIssuedToken(link: LinkDoc) {
  if (link.tokenIssuedToPeer) await ctx.store.update('apiKeys', link.tokenIssuedToPeer.keyId, { revokedAt: now() });
}

/** Link ends (either side): revoke tokens, keep the person as "Contact only". */
export async function endLink(link: LinkDoc, reason: string) {
  await revokeIssuedToken(link);
  await ctx.store.update('nodeLinks', link._id, { status: 'revoked', tokenFromPeerEnc: null, tokenIssuedToPeer: null });
  await ctx.store.removeMany('connectionRequests', { linkId: link._id, status: 'pending' });
  const c = await ctx.store.get<ContactDoc>('contacts', link.contactId);
  if (c) {
    const methods: Method[] = [...c.methods];
    if (!methods.some((m) => m.type === 'url')) methods.push({ type: 'url', label: 'Little Dipper', value: displayAddr(link.peerUrl) });
    await ctx.store.update('contacts', c._id, { kind: 'person', node: null, sharedIn: [], sharedDomains: [], sharedInFetchedAt: null, methods, lastActivity: { text: reason, at: now() } });
  }
}

/** Fields this contact's token may read right now. */
export async function sharedOut(contactId: string, which: 'profile' | 'fields'): Promise<{ key: string; label: string; value: string }[]> {
  const g = await grantsFor(contactId);
  const fields = await allFields();
  if (which === 'profile') {
    if (!g.profile) return [];
    return fields.filter((f) => f.sensitivity === 'standard' && plainValue(f)).map((f) => ({ key: f.key, label: f.label, value: plainValue(f) }));
  }
  return fields
    .filter((f) => g.fields.includes(f.key) && (f.sensitivity !== 'standard' || !g.profile) && plainValue(f))
    .map((f) => ({ key: f.key, label: f.label, value: plainValue(f) }));
}

/** Pull what a connected contact shares with us and cache it locally. */
// ── change nudges ─────────────────────────────────────────────────────
// When what a connection can read changes, tell their node to sync now instead of on its next stale check.
const pending = new Map<string, NodeJS.Timeout>();

/** Debounced per link: a burst of edits sends one nudge. contactIds = null means every active connection. */
export function nudgePeers(contactIds: string[] | null) {
  (async () => {
    const links = await ctx.store.find<LinkDoc>('nodeLinks', { status: 'active' });
    for (const l of links) {
      if (contactIds && !contactIds.includes(l.contactId)) continue;
      clearTimeout(pending.get(l._id));
      pending.set(l._id, setTimeout(() => {
        pending.delete(l._id);
        sendSigned(l.peerUrl, '/peer/v1/links/changed', { type: 'link.changed' }).catch(() => { /* they'll catch up on their next sync */ });
      }, 1500));
    }
  })().catch(() => {});
}

/** Contacts with an active link that can read this domain. */
export async function contactsSharing(domain: string) {
  const grants = await ctx.store.find<{ _id: string; contactId: string; domain?: string }>('grants', { domain });
  return grants.map((g) => g.contactId);
}

export async function syncContact(c: ContactDoc) {
  const link = await linkFor(c);
  if (!link || link.status !== 'active') return c;
  const profile = (await peerGet(link, '/peer/v1/profile')) as { fields?: ContactDoc['sharedIn'] };
  const extra = (await peerGet(link, '/peer/v1/fields')) as { fields?: ContactDoc['sharedIn'] };
  const seen = new Set<string>();
  const sharedIn = [...(profile.fields || []), ...(extra.fields || [])]
    .filter((f) => f && typeof f.key === 'string' && !seen.has(f.key) && seen.add(f.key))
    .map((f) => ({ key: String(f.key), label: String(f.label).slice(0, 80), value: String(f.value).slice(0, 2000) }));
  // Domains they've granted us. Older nodes don't have this endpoint: treat as none.
  const sharedDomains: SharedDomain[] = [];
  const list = (await peerGet(link, '/peer/v1/domains').catch(() => ({ domains: [] }))) as { domains?: { id: string }[] };
  for (const { id } of (list.domains || []).slice(0, 50)) {
    if (!/^[a-z0-9_]{1,40}$/.test(String(id))) continue;
    const d = (await peerGet(link, `/peer/v1/domains/${id}`).catch(() => null)) as SharedDomain | null;
    if (!d || !Array.isArray(d.records)) continue;
    sharedDomains.push({
      domain: id, label: String(d.label).slice(0, 80), scope: d.scope === 'current' ? 'current' : 'all',
      records: d.records.slice(0, 500).map((r) => ({
        id: String(r.id), title: String(r.title).slice(0, 200),
        fields: (r.fields || []).slice(0, 60).map((f) => ({ key: String(f.key), label: String(f.label).slice(0, 80), value: String(f.value).slice(0, 2000) })),
        data: typeof r.data === 'object' && r.data ? r.data : {}, validFrom: r.validFrom ?? null, validTo: r.validTo ?? null, current: !!r.current, updatedAt: String(r.updatedAt || ''),
      })),
    });
  }
  const t = now();
  await ctx.store.update('contacts', c._id, { sharedIn, sharedDomains, sharedInFetchedAt: t });
  await ctx.store.update('nodeLinks', link._id, { lastSyncAt: t, tokenFromPeerLastUsedAt: t });
  return (await ctx.store.get<ContactDoc>('contacts', c._id))!;
}

export async function newNodeContact(opts: { displayName: string; address: string; nodeId: string; signingKey: string; version: string | null; status: LinkDoc['status']; requestId: string; offered?: string[]; requested?: string[] }) {
  const contactId = newId('con');
  const linkId = newId('lnk');
  const t = now();
  const contact: ContactDoc = {
    _id: contactId, kind: 'node', displayName: opts.displayName, org: null, methods: [], notes: '',
    node: { url: opts.address, nodeId: opts.nodeId, linkId }, sharedIn: [], sharedInFetchedAt: null,
    requested: opts.requested || [], offered: opts.offered || [],
    lastActivity: { text: opts.status === 'pending_out' ? 'Request sent' : 'Request received', at: t }, createdAt: t,
  };
  const link: LinkDoc = {
    _id: linkId, contactId, peerNodeId: opts.nodeId, peerUrl: opts.address, status: opts.status, peerSigningKey: opts.signingKey,
    peerVersion: opts.version, requestId: opts.requestId, tokenIssuedToPeer: null, tokenFromPeerEnc: null, tokenFromPeerLastUsedAt: null,
    timeline: [{ label: opts.status === 'pending_out' ? 'Request sent by you' : `Request received from ${firstName(opts.displayName)}`, at: t }],
    establishedAt: null, lastSyncAt: null, rotatedAt: null,
  };
  await ctx.store.insert('contacts', contact);
  await ctx.store.insert('nodeLinks', link);
  return { contact, link };
}

/** An existing contact (any status) for this peer, so repeat requests reuse it. */
export async function existingForNode(nodeId: string) {
  const link = (await ctx.store.find<LinkDoc>('nodeLinks', { peerNodeId: nodeId })).find((l) => l.status !== 'revoked');
  if (!link) return null;
  const contact = await ctx.store.get<ContactDoc>('contacts', link.contactId);
  return contact ? { contact, link } : null;
}

