import { config, VERSION } from './config.js';
import { ctx } from './ctx.js';
import { fingerprint, nodeIdFromPublicKey, randomToken, sha256 } from './crypto.js';
import { loadKeystore, newKeystore, saveKeystore } from './keystore.js';
import type { Doc } from './store/index.js';

export type NodeDoc = Doc & {
  type: 'node';
  claimed: boolean;
  claimTokenHash: string | null;
  claimTokenExpiresAt: string | null;
  claimMode?: 'claim' | 'transfer';
  ownerId: string | null;
  addresses: { host: string; domain: string | null; domainStatus: 'none' | 'pending' | 'active' };
  signingKey: { alg: 'ed25519'; publicKey: string; privateKeyRef: string };
  keyHistory: { publicKey: string; retiredAt: string; successorSignature: string }[];
  addressHistory: { address: string; from: string; to: string | null }[];
  version: string;
  hosting: { provider: string; region: string };
  publicViews?: { day: string; count: number };
  lastBackupAt?: string | null;
  blockedNodeIds?: string[];
  /** One-time migrations already applied (see migrate.ts). */
  migrations?: string[];
  createdAt: string;
  claimedAt: string | null;
};

export const CLAIM_TTL_MS = 60 * 60 * 1000;

export async function getNode(): Promise<NodeDoc> {
  const n = await ctx.store.findOne<NodeDoc>('nodes', { type: 'node' });
  if (!n) throw new Error('node not initialised');
  return n;
}

const originOf = (addr: string) => (/^https?:\/\//.test(addr) ? addr : `https://${addr}`).replace(/\/+$/, '');

/** The address people should use right now: a verified custom domain, else the host address. */
export function canonicalUrl(n: NodeDoc): string {
  return n.addresses.domain && n.addresses.domainStatus === 'active' ? originOf(n.addresses.domain) : n.addresses.host;
}

/** Display form without scheme: "maya-ld.onrender.com". */
export const displayAddr = (url: string) => url.replace(/^https?:\/\//, '');

/** What this node can do, advertised in its descriptor. Additive only: a capability is never withdrawn (docs/COMPATIBILITY.md VII). */
export const CAPABILITIES = ['messages'] as const;

export function descriptor(n: NodeDoc, displayName: string | null, connectRequests: string) {
  const base = canonicalUrl(n);
  return {
    kind: 'node' as const,
    nodeId: n._id,
    version: n.version,
    signingKey: n.signingKey.publicKey,
    signingKeyFingerprint: fingerprint(n.signingKey.publicKey),
    displayName,
    address: base,
    addresses: [n.addresses.host, ...(n.addresses.domain && n.addresses.domainStatus === 'active' ? [originOf(n.addresses.domain)] : [])],
    profile: `${base}/`,
    federation: `${base}/peer/v1`,
    connectRequests,
    claimed: n.claimed,
    capabilities: [...CAPABILITIES],
  };
}

/** Issue a fresh claim link. Invalidates any earlier one. */
export async function issueClaimLink(mode: 'claim' | 'transfer' = 'claim', token?: string): Promise<{ url: string; expiresAt: string }> {
  const n = await getNode();
  const t = token || 'ct_' + randomToken(18);
  const expiresAt = new Date(Date.now() + (mode === 'transfer' ? 24 * 3600_000 : CLAIM_TTL_MS)).toISOString();
  await ctx.store.update('nodes', n._id, { claimTokenHash: sha256(t), claimTokenExpiresAt: expiresAt, claimMode: mode });
  return { url: `${canonicalUrl(n)}/claim?token=${t}`, expiresAt };
}

export async function checkClaimToken(token: string): Promise<NodeDoc | null> {
  const n = await getNode();
  if (!n.claimTokenHash || !n.claimTokenExpiresAt) return null;
  if (new Date(n.claimTokenExpiresAt).getTime() < Date.now()) return null;
  return sha256(token) === n.claimTokenHash ? n : null;
}

/** CLI: load the existing identity without touching addresses (the CLI's env may differ from the server's). */
export async function attachNode() {
  const ks = await loadKeystore(ctx.store);
  const n = await ctx.store.findOne<NodeDoc>('nodes', { type: 'node' });
  if (!ks || !n) throw new Error('No Little Dipper here yet. Start the server once first (it creates the identity), with the same LD_DATA_DIR / MONGODB_URI.');
  ctx.keys = ks;
  return n;
}

/** First boot: create the permanent identity. Every boot: reconcile the host address. */
export async function bootNode(log: (msg: string) => void) {
  let ks = await loadKeystore(ctx.store);
  let n = await ctx.store.findOne<NodeDoc>('nodes', { type: 'node' });
  if (!ks) {
    if (n) throw new Error('Keystore missing but the database already has a node. Restore your recovery kit (little-dipper restore-kit <file>) or point LD_DATA_DIR at the original data.');
    ks = newKeystore();
    await saveKeystore(ctx.store, ks);
  }
  ctx.keys = ks;
  const nodeId = nodeIdFromPublicKey(ks.signing.publicKey);
  const now = new Date().toISOString();
  if (!n) {
    n = {
      _id: nodeId, type: 'node', claimed: false, claimTokenHash: null, claimTokenExpiresAt: null, ownerId: null,
      addresses: { host: config.hostUrl, domain: null, domainStatus: 'none' },
      signingKey: { alg: 'ed25519', publicKey: ks.signing.publicKey, privateKeyRef: 'keystore://node/signing' },
      keyHistory: [], addressHistory: [{ address: config.hostUrl, from: now, to: null }],
      version: VERSION, hosting: { provider: config.hosting.provider, region: config.hosting.region },
      createdAt: now, claimedAt: null,
    } satisfies NodeDoc;
    await ctx.store.insert('nodes', n);
    log(`Created permanent identity ${nodeId}`);
  } else if (n._id !== nodeId) {
    throw new Error(`Keystore (${nodeId}) does not match this database (${n._id}).`);
  }
  const patch: Partial<NodeDoc> = {};
  if (n.version !== VERSION) patch.version = VERSION;
  let moved: string | null = null;
  if (n.addresses.host !== config.hostUrl) {
    moved = n.addresses.host;
    patch.addresses = { ...n.addresses, host: config.hostUrl };
    patch.addressHistory = [...n.addressHistory.map((h) => (h.to ? h : { ...h, to: now })), { address: config.hostUrl, from: now, to: null }];
  }
  if (Object.keys(patch).length) await ctx.store.update('nodes', n._id, patch);

  if (!n.claimed) {
    // An installer may pre-generate the token (e.g. Render's generateValue) and open /claim?token=… itself.
    const envToken = process.env.LD_CLAIM_TOKEN;
    const valid = n.claimTokenExpiresAt && new Date(n.claimTokenExpiresAt).getTime() > Date.now();
    if (envToken && !n.claimTokenHash) {
      const { url } = await issueClaimLink('claim', envToken);
      log(`Claim this node: ${url}`);
    } else if (!valid) {
      const { url } = await issueClaimLink();
      log(`Claim this node: ${url}`);
    } else {
      log('Not claimed yet. A claim link is still valid; run `little-dipper claim-link` for a fresh one.');
    }
  }
  return { moved };
}
