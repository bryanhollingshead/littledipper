/**
 * Instance-to-instance connections.
 *
 * Every peer→peer message is a signed envelope { payload, signature } where the
 * signature is ed25519 over the canonical JSON of payload, made with the sending
 * node's signing key. A node's ID is derived from that key, so a descriptor is
 * self-certifying: no registry needed.
 */
import { config } from './config.js';
import { ctx } from './ctx.js';
import { decrypt, encrypt, newId, nodeIdFromPublicKey, randomToken, sha256, sign, verify } from './crypto.js';
import { bad, HttpError } from './auth.js';
import { canonicalUrl, getNode } from './node.js';
import type { Doc } from './store/index.js';
import type { SharedDomain } from './domains/sharing.js';

// ── documents ───────────────────────────────────────────────────────────

export type Method = { type: 'email' | 'phone' | 'address' | 'url' | 'note'; label: string; value: string };

export type ContactDoc = Doc & {
  kind: 'person' | 'node';
  displayName: string;
  org: string | null;
  methods: Method[];
  notes: string;
  node: { url: string; nodeId: string; linkId: string } | null;
  sharedIn: { key: string; label: string; value: string }[];
  /** Domains they share with us (employment, residences…), as fetched from their node. */
  sharedDomains?: SharedDomain[];
  sharedInFetchedAt: string | null;
  /** Fields this contact asked us for in their request. */
  requested: string[];
  /** Field labels they offered in their request (values arrive after accept). */
  offered: string[];
  lastActivity: { text: string; at: string };
  createdAt: string;
};

export type LinkStatus = 'pending_out' | 'pending_in' | 'active' | 'revoked';
export type LinkDoc = Doc & {
  contactId: string;
  peerNodeId: string;
  /** Last known address. A hint; peerNodeId is the identity. */
  peerUrl: string;
  status: LinkStatus;
  peerSigningKey: string;
  peerVersion: string | null;
  requestId: string;
  tokenIssuedToPeer: { keyId: string; scope: string } | null;
  tokenFromPeerEnc: string | null;
  tokenFromPeerLastUsedAt: string | null;
  timeline: { label: string; at: string }[];
  establishedAt: string | null;
  lastSyncAt: string | null;
  rotatedAt: string | null;
};

export type RequestDoc = Doc & {
  direction: 'in' | 'out';
  /** The id both sides use for this request (the sender's id). */
  requestId: string;
  fromNodeId: string;
  fromNode: string;
  /** The other side's display name. */
  peerName: string;
  toNode: string;
  offeredFields: string[];
  offeredLabels: string[];
  requestedFields: string[];
  note: string;
  nonce: string;
  signature: string;
  inviteId: string | null;
  /** Stranger requests under connectRequests=anyone wait quietly (no badge). */
  quiet: boolean;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  contactId: string;
  linkId: string;
  createdAt: string;
  expiresAt: string;
};

export type GrantDoc = Doc & {
  contactId: string;
  /** profile:true = every Standard field (the basic profile). */
  profile?: boolean;
  /** One doc per extra Sensitive/Secret field. */
  fieldKey?: string;
  /** One doc per shared domain (employment, residences…). */
  domain?: string;
  /** Domain grants: every record, or only current ones. */
  scope?: 'all' | 'current';
  access: 'read';
  confirmedSecret: boolean;
  grantedAt: string;
  expiresAt: string | null;
};

export type InviteDoc = Doc & {
  tokenHash: string;
  offeredFields: string[];
  singleUse: true;
  expiresAt: string;
  usedByNodeId: string | null;
  createdAt: string;
};

export type PublicProfileDoc = Doc & {
  displayName: string;
  headline: string;
  avatarFileId: string | null;
  fieldKeys: string[];
  connectRequests: 'off' | 'fof' | 'anyone';
};

export const REQUEST_TTL_DAYS = 14;
export const now = () => new Date().toISOString();

// ── addresses ───────────────────────────────────────────────────────────

/** Accepts "theo.nakamura.net", "https://theo.net", or a full invite link. */
export function parsePeerInput(input: string): { origin: string; invite: string | null } {
  const raw = input.trim();
  if (!raw) throw bad('address_required', 'Enter their address');
  const isLocal = /^(localhost|127\.|\[::1\])/.test(raw.replace(/^https?:\/\//, ''));
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `${isLocal ? 'http' : 'https'}://${raw}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw bad('bad_address', "That doesn't look like a web address");
  }
  if (u.protocol === 'http:' && !(config.devInsecurePeers || isLocal)) throw bad('https_required', 'Little Dipper addresses must use https');
  return { origin: u.origin, invite: u.searchParams.get('invite') };
}

// ── signed envelopes ────────────────────────────────────────────────────

type Envelope<T> = { payload: T & { from: string; ts: number; nonce: string }; signature: string };

export async function envelope<T extends object>(payload: T): Promise<Envelope<T>> {
  const n = await getNode();
  const p = { ...payload, from: n._id, ts: Date.now(), nonce: randomToken(12) };
  return { payload: p, signature: sign(ctx.keys.signing.privateKey, p) };
}

const seenNonces = new Map<string, number>();
const SKEW_MS = 10 * 60_000;

/** Verify signature, freshness and replay. Returns the payload. */
export function openEnvelope<T>(body: unknown, publicKey: string): Envelope<T>['payload'] {
  const env = body as Envelope<T>;
  if (!env || typeof env !== 'object' || !env.payload || typeof env.signature !== 'string') throw bad('bad_envelope');
  if (!verify(publicKey, env.payload, env.signature)) throw new HttpError(401, 'bad_signature');
  if (Math.abs(Date.now() - Number(env.payload.ts)) > SKEW_MS) throw new HttpError(401, 'stale_message');
  const nk = `${env.payload.from}:${env.payload.nonce}`;
  if (seenNonces.has(nk)) throw new HttpError(409, 'replayed');
  seenNonces.set(nk, Date.now());
  if (seenNonces.size > 5000) for (const [k, t] of seenNonces) if (Date.now() - t > SKEW_MS) seenNonces.delete(k);
  return env.payload;
}

async function peerFetch(url: string, init: RequestInit & { json?: unknown } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10_000);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ac.signal,
      redirect: 'follow',
      headers: { accept: 'application/json', ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { ok: res.ok, status: res.status, data: data as Record<string, unknown> | null };
  } catch (e) {
    throw new HttpError(502, 'peer_unreachable', `Couldn't reach ${new URL(url).host}. Check the address and try again.`);
  } finally {
    clearTimeout(t);
  }
}

export type Descriptor = { nodeId: string; version: string; signingKey: string; displayName: string | null; address: string; connectRequests: string; claimed: boolean };

/** Fetch and verify another node's descriptor. */
export async function lookupDescriptor(origin: string): Promise<Descriptor> {
  const r = await peerFetch(`${origin}/.well-known/little-dipper`);
  const d = r.data as Descriptor | null;
  if (!r.ok || !d?.nodeId || !d.signingKey) throw new HttpError(502, 'not_little_dipper', "We couldn't find a Little Dipper at that address.");
  if (nodeIdFromPublicKey(d.signingKey) !== d.nodeId) throw new HttpError(502, 'identity_mismatch', "That address answered, but its identity didn't check out.");
  if (!d.claimed) throw new HttpError(409, 'peer_unclaimed', "That Little Dipper hasn't been set up by its owner yet.");
  return d;
}

/** POST a signed message to a peer. If peerKey is given, the response must be signed by it. */
export async function sendSigned<T extends object, R = Record<string, unknown>>(origin: string, path: string, payload: T, peerKey?: string): Promise<R> {
  const r = await peerFetch(`${origin}${path}`, { method: 'POST', json: await envelope(payload) });
  if (!r.ok) {
    const msg = (r.data?.message as string) || `Their Little Dipper answered ${r.status}`;
    throw new HttpError(r.status === 404 || r.status >= 500 ? 502 : r.status === 401 ? 400 : r.status, (r.data?.code as string) || 'peer_error', msg);
  }
  if (peerKey) return openEnvelope<R>(r.data, peerKey) as R;
  return (r.data || {}) as R;
}

// ── tokens between linked nodes ─────────────────────────────────────────

export const peerTokenFor = (link: LinkDoc) => (link.tokenFromPeerEnc ? decrypt(ctx.keys.masterKey, link.tokenFromPeerEnc) : null);
export const sealToken = (t: string) => encrypt(ctx.keys.masterKey, t);

export async function peerGet(link: LinkDoc, path: string) {
  const token = peerTokenFor(link);
  if (!token) throw new HttpError(409, 'no_peer_token');
  const r = await peerFetch(`${link.peerUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new HttpError(502, 'peer_error', (r.data?.message as string) || `Their Little Dipper answered ${r.status}`);
  return r.data || {};
}

// ── grants ──────────────────────────────────────────────────────────────

export async function grantsFor(contactId: string) {
  const docs = await ctx.store.find<GrantDoc>('grants', { contactId });
  const profileDoc = docs.find((d) => d.fieldKey === undefined && d.domain === undefined);
  return {
    profile: profileDoc ? profileDoc.profile !== false : true,
    fields: docs.filter((d) => d.fieldKey).map((d) => d.fieldKey as string),
    /** domain → what is shared. Secret parts only when includeSecret was confirmed. */
    domains: Object.fromEntries(docs.filter((d) => d.domain).map((d) => [d.domain as string, { scope: d.scope || 'all', includeSecret: d.confirmedSecret }])) as Record<string, { scope: 'all' | 'current'; includeSecret: boolean }>,
    docs,
  };
}

export async function setProfileGrant(contactId: string, on: boolean) {
  const g = await ctx.store.find<GrantDoc>('grants', { contactId });
  const p = g.find((d) => d.fieldKey === undefined && d.domain === undefined);
  if (p) await ctx.store.update('grants', p._id, { profile: on, grantedAt: now() });
  else await ctx.store.insert<GrantDoc>('grants', { _id: newId('grt'), contactId, profile: on, access: 'read', confirmedSecret: false, grantedAt: now(), expiresAt: null });
}

export async function setFieldGrant(contactId: string, fieldKey: string, on: boolean, confirmedSecret = false) {
  const existing = await ctx.store.findOne<GrantDoc>('grants', { contactId, fieldKey });
  if (on && !existing) await ctx.store.insert<GrantDoc>('grants', { _id: newId('grt'), contactId, fieldKey, access: 'read', confirmedSecret, grantedAt: now(), expiresAt: null });
  if (!on && existing) await ctx.store.remove('grants', existing._id);
}

export async function setDomainGrant(contactId: string, domain: string, grant: { scope: 'all' | 'current'; includeSecret: boolean } | null) {
  const existing = await ctx.store.findOne<GrantDoc>('grants', { contactId, domain });
  if (!grant) { if (existing) await ctx.store.remove('grants', existing._id); return; }
  const patch = { scope: grant.scope, confirmedSecret: grant.includeSecret, grantedAt: now() };
  if (existing) await ctx.store.update('grants', existing._id, patch);
  else await ctx.store.insert<GrantDoc>('grants', { _id: newId('grt'), contactId, domain, access: 'read', expiresAt: null, ...patch });
}

/** sha256(peerNodeId + recipientNodeId) for each active peer: lets a recipient spot mutual contacts without learning the rest. */
export async function mutualHints(recipientNodeId: string) {
  const links = await ctx.store.find<LinkDoc>('nodeLinks', { status: 'active' });
  return links.map((l) => sha256(l.peerNodeId + recipientNodeId));
}

export async function hasMutual(hints: unknown, selfId: string) {
  if (!Array.isArray(hints)) return false;
  const mine = new Set((await ctx.store.find<LinkDoc>('nodeLinks', { status: 'active' })).map((l) => sha256(l.peerNodeId + selfId)));
  return hints.some((h) => mine.has(String(h)));
}

export async function selfAddress() {
  return canonicalUrl(await getNode());
}

export const tokenHash = sha256;
