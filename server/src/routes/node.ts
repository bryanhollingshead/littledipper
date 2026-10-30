import { resolveTxt } from 'node:dns/promises';
import type { FastifyInstance } from 'fastify';
import { config, VERSION } from '../config.js';
import { ctx } from '../ctx.js';
import { fingerprint, encryptWithPassphrase, decrypt, isEncrypted } from '../crypto.js';
import { audit, ownerActor, systemActor } from '../audit.js';
import { bad, COOKIE, cookieOpts, HttpError, issueKey, rateLimit, requireOwner, requireSession, requireSetup, startSession, deviceLabel } from '../auth.js';
import { canonicalUrl, checkClaimToken, descriptor, displayAddr, getNode, issueClaimLink, type NodeDoc } from '../node.js';
import { createBackup, listBackups, restoreBackup } from '../backups.js';
import { seedFields } from '../fields.js';
import { runMigrations } from '../migrate.js';
import { getOwner, getPendingOwner, type OwnerDoc } from '../owner.js';
import { now, sendSigned, type LinkDoc, type PublicProfileDoc } from '../federation.js';
import { COLLECTIONS } from '../store/index.js';
import { plainData } from '../domains/records.js';
import type { RecordDoc } from '../domains/types.js';

let updateCache: { at: number; latest: { version: string; notes: string } | null } = { at: 0, latest: null };
async function latestRelease() {
  if (!config.updateFeedUrl) return null;
  if (Date.now() - updateCache.at < 3600_000) return updateCache.latest;
  try {
    const r = await fetch(config.updateFeedUrl, { signal: AbortSignal.timeout(5000) });
    const j = (await r.json()) as { version: string; notes?: string };
    updateCache = { at: Date.now(), latest: { version: j.version, notes: j.notes || '' } };
  } catch {
    updateCache = { at: Date.now(), latest: null };
  }
  return updateCache.latest;
}
const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};

export async function updateInfo() {
  const latest = await latestRelease();
  return { current: VERSION, latest: latest?.version || VERSION, available: !!latest && newer(latest.version, VERSION), notes: latest?.notes || '', canSelfUpdate: !!config.deployHookUrl };
}

function domainRecords(n: NodeDoc) {
  if (!n.addresses.domain) return [];
  const host = displayAddr(n.addresses.host);
  return [
    { type: 'ALIAS', name: '@', value: host },
    { type: 'CNAME', name: 'www', value: host },
    { type: 'TXT', name: '_little-dipper', value: `ld-verify=${n._id}` },
  ];
}

export async function publicProfileDoc() {
  return ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
}

/** Tell every connection (people and businesses) where we live now. Tokens stay valid. */
export async function announceAddress(log?: (m: string) => void) {
  const n = await getNode();
  const addr = canonicalUrl(n);
  const links = await ctx.store.find<LinkDoc>('nodeLinks', { status: 'active' });
  const notified: string[] = [];
  for (const l of links) {
    try {
      await sendSigned(l.peerUrl, '/peer/v1/address-change', { type: 'address.change', nodeId: n._id, newAddress: addr });
      notified.push(displayAddr(l.peerUrl));
    } catch (e) {
      log?.(`address-change to ${l.peerUrl} failed: ${(e as Error).message}`);
    }
  }
  return { newAddress: addr, notified };
}

async function nodeOut() {
  const n = await getNode();
  const counts = await Promise.all(COLLECTIONS.filter((c) => c !== 'challenges').map((c) => ctx.store.count(c)));
  const docs = counts.reduce((a, b) => a + b, 0);
  return {
    id: n._id,
    signingKey: fingerprint(n.signingKey.publicKey),
    address: canonicalUrl(n),
    addresses: { host: n.addresses.host, domain: n.addresses.domain, domainStatus: n.addresses.domainStatus, records: domainRecords(n) },
    addressHistory: n.addressHistory,
    version: n.version,
    update: await updateInfo(),
    hosting: { provider: n.hosting.provider, label: config.hosting.label, region: n.hosting.region, store: 'SQLite', documents: docs },
    lastBackupAt: n.lastBackupAt || null,
    publicViewsToday: n.publicViews?.day === new Date().toISOString().slice(0, 10) ? n.publicViews.count : 0,
    claimedAt: n.claimedAt,
  };
}

export default async function nodeRoutes(app: FastifyInstance) {
  app.get('/.well-known/little-dipper', async () => {
    const n = await getNode();
    const pp = await publicProfileDoc();
    return descriptor(n, n.claimed ? pp?.displayName || (await getOwner())?.displayName || null : null, pp?.connectRequests || 'off');
  });

  app.get('/api/v1/node/status', async () => {
    const n = await getNode();
    const docs = await ctx.store.count('fields');
    return {
      claimed: n.claimed, version: n.version, address: canonicalUrl(n),
      hosting: { label: config.hosting.label, region: n.hosting.region },
      storage: docs ? 'In use' : 'Ready and empty',
      claimHint: n.claimed ? null : 'Open the claim link from your installer or run `little-dipper claim-link`',
    };
  });

  // ── claim & setup ─────────────────────────────────────────────────────
  app.post('/api/v1/node/claim', async (req, reply) => {
    rateLimit(req, 'claim', 20, 15 * 60_000);
    const { token } = (req.body || {}) as { token?: string };
    const raw = String(token || '').trim();
    const t = raw.includes('token=') ? new URL(raw, 'http://x').searchParams.get('token') || '' : raw;
    const n = t ? await checkClaimToken(t) : null;
    if (!n) throw new HttpError(401, 'invalid_or_expired_token', "That link isn't valid for this Little Dipper, or it has expired.");
    if (n.claimed && n.claimMode !== 'transfer') throw new HttpError(409, 'already_claimed');
    // Drop any half-finished setup.
    await ctx.store.removeMany('owners', { pending: true });
    await ctx.store.removeMany('apiKeys', { kind: 'setup' });
    const { secret } = await issueKey({ kind: 'setup', name: 'Setup session', scopes: ['setup'], ttlSec: 3600 });
    reply.setCookie(COOKIE.setup, secret, cookieOpts(3600));
    return { setupSession: true, mode: n.claimMode || 'claim', expiresIn: 3600, address: canonicalUrl(n) };
  });

  app.post('/api/v1/node/claim/complete', async (req, reply) => {
    const setupKey = await requireSetup(req);
    const pending = await getPendingOwner();
    if (!pending) throw bad('owner_missing', 'Add your name first');
    if (!pending.passkeys.length) throw bad('passkey_missing', 'Create a passkey first');
    if (!pending.recoveryCodeHashes.length) throw bad('codes_missing', 'Generate recovery codes first');
    const n = await getNode();
    const transfer = n.claimed;
    if (transfer) {
      // Ownership transfer: the previous owner's credentials and sessions go away. Data stays.
      for (const o of await ctx.store.find<OwnerDoc>('owners', { pending: { $ne: true } })) await ctx.store.remove('owners', o._id);
      await ctx.store.removeMany('apiKeys', { kind: 'session' });
    }
    await ctx.store.update('owners', pending._id, { pending: undefined });
    await ctx.store.update('nodes', n._id, { claimed: true, ownerId: pending._id, claimTokenHash: null, claimTokenExpiresAt: null, claimMode: undefined, claimedAt: now() });
    await ctx.store.update('apiKeys', setupKey._id, { revokedAt: now() });
    reply.clearCookie(COOKIE.setup, { path: '/' });
    if (!transfer) {
      const first = pending.displayName.split(' ')[0];
      await seedFields({ legal_name: pending.displayName, preferred_name: first, email: pending.email });
      await runMigrations();
      if (!(await publicProfileDoc())) {
        await ctx.store.insert<PublicProfileDoc>('publicProfile', { _id: 'public', displayName: pending.displayName, headline: '', avatarFileId: null, fieldKeys: ['preferred_name'], connectRequests: 'off' });
      }
    }
    await startSession(reply, deviceLabel(req));
    await audit({ actor: systemActor, action: 'node.claim', resource: `nodes/${n._id}`, text: transfer ? `Ownership transferred to ${pending.displayName}` : `${pending.displayName} claimed this Little Dipper`, tone: 'system' });
    return { claimed: true, address: canonicalUrl(n), nodeId: n._id };
  });

  // ── owner-facing node settings ───────────────────────────────────────
  app.get('/api/v1/node', async (req) => {
    await requireOwner(req, 'owner:read');
    return nodeOut();
  });

  app.patch('/api/v1/node', async (req) => {
    const p = await requireSession(req);
    const body = (req.body || {}) as { domain?: string | null };
    const n = await getNode();
    if (body.domain !== undefined) {
      const wasActive = n.addresses.domainStatus === 'active';
      if (body.domain === null || body.domain === '') {
        await ctx.store.update('nodes', n._id, {
          addresses: { ...n.addresses, domain: null, domainStatus: 'none' },
          addressHistory: wasActive ? [...n.addressHistory.map((h) => (h.to ? h : { ...h, to: now() })), { address: n.addresses.host, from: now(), to: null }] : n.addressHistory,
        });
        if (wasActive) await announceAddress(req.log.warn.bind(req.log));
        await audit({ actor: ownerActor(p.key._id), action: 'node.domain.remove', resource: 'nodes', text: 'You removed your custom domain', tone: 'owner' });
      } else {
        const d = String(body.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d)) throw bad('bad_domain', 'Enter a domain like yourname.com');
        await ctx.store.update('nodes', n._id, { addresses: { ...n.addresses, domain: d, domainStatus: 'pending' } });
        await audit({ actor: ownerActor(p.key._id), action: 'node.domain.add', resource: 'nodes', text: `You started connecting ${d}`, tone: 'owner' });
      }
    }
    return nodeOut();
  });

  app.post('/api/v1/node/domain/check', async (req) => {
    const p = await requireSession(req);
    const n = await getNode();
    const d = n.addresses.domain;
    if (!d) throw bad('no_domain');
    const checks = { txt: false, reachable: false };
    try {
      const recs = (await resolveTxt(`_little-dipper.${d}`)).map((r) => r.join(''));
      checks.txt = recs.includes(`ld-verify=${n._id}`);
    } catch { /* not yet */ }
    try {
      const r = await fetch(`https://${d}/.well-known/little-dipper`, { signal: AbortSignal.timeout(6000) });
      checks.reachable = r.ok && ((await r.json()) as { nodeId?: string }).nodeId === n._id;
    } catch { /* not yet */ }
    if (checks.txt && checks.reachable && n.addresses.domainStatus !== 'active') {
      await ctx.store.update('nodes', n._id, {
        addresses: { ...n.addresses, domainStatus: 'active' },
        addressHistory: [...n.addressHistory.map((h) => (h.to ? h : { ...h, to: now() })), { address: `https://${d}`, from: now(), to: null }],
      });
      const res = await announceAddress(req.log.warn.bind(req.log));
      await audit({ actor: ownerActor(p.key._id), action: 'node.address', resource: 'nodes', text: `${d} connected · ${res.notified.length} connection${res.notified.length === 1 ? '' : 's'} told automatically`, tone: 'owner' });
    }
    return { ...checks, node: await nodeOut() };
  });

  app.post('/api/v1/node/address-change/announce', async (req) => {
    await requireSession(req);
    return announceAddress(req.log.warn.bind(req.log));
  });

  app.post('/api/v1/node/update', async (req) => {
    const p = await requireSession(req);
    const u = await updateInfo();
    if (!u.available) return { status: 'up_to_date', version: u.current };
    if (!config.deployHookUrl) throw new HttpError(501, 'host_managed', 'Updates for this install are managed by your host. Pull the new image or redeploy.');
    const pre = await createBackup('pre-update');
    const r = await fetch(config.deployHookUrl, { method: 'POST' });
    if (!r.ok) throw new HttpError(502, 'deploy_failed', 'Your host rejected the update request.');
    await audit({ actor: ownerActor(p.key._id), action: 'node.update', resource: 'nodes', text: `Update to ${u.latest} started`, tone: 'owner' });
    return { from: u.current, to: u.latest, preBackup: pre._id, status: 'deploying' };
  });

  // ── backups, export, recovery kit ─────────────────────────────────────
  app.get('/api/v1/node/backups', async (req) => {
    await requireOwner(req, 'owner:read');
    return { items: await listBackups(), schedule: 'Nightly at 03:00 · encrypted with your owner key · kept 30 days', destination: `${config.dataDir}/backups` };
  });

  app.post('/api/v1/node/backups', async (req, reply) => {
    const p = await requireSession(req);
    const b = await createBackup('manual');
    await audit({ actor: ownerActor(p.key._id), action: 'backup.create', resource: `backups/${b._id}`, text: `Backup completed · ${b.documents} documents`, tone: 'system' });
    reply.code(201);
    return b;
  });

  app.post('/api/v1/node/backups/:id/restore', async (req) => {
    const p = await requireSession(req);
    const { id } = req.params as { id: string };
    await restoreBackup(id);
    await runMigrations(); // a backup from an older version comes back in today's shape
    await audit({ actor: ownerActor(p.key._id), action: 'backup.restore', resource: `backups/${id}`, text: 'You restored a backup', tone: 'owner' });
    return { restored: true };
  });

  app.get('/api/v1/export', async (req, reply) => {
    const p = await requireOwner(req, 'export');
    const dump = await ctx.store.dump();
    const lines: string[] = [];
    for (const [coll, docs] of Object.entries(dump)) {
      if (coll === 'challenges') continue;
      for (const d of docs) {
        if (coll === 'nodes' && d._id === '__keystore') continue;
        if (coll === 'apiKeys') continue; // credential hashes stay home
        const out = { ...d };
        // Owner export: Secret values are decrypted so the file is usable on its own.
        if (coll === 'fields' && isEncrypted(out.value)) out.value = decrypt(ctx.keys.masterKey, out.value);
        if ((coll === 'records' || coll === 'recordVersions') && out.data) out.data = plainData(out as RecordDoc);
        if (coll === 'owners') { delete out.passwordHash; delete out.totp; delete out.recoveryCodeHashes; }
        if (coll === 'nodeLinks') delete out.tokenFromPeerEnc;
        if (coll === 'messages' && isEncrypted(out.body)) out.body = JSON.parse(decrypt(ctx.keys.masterKey, out.body));
        if (coll === 'documents' && isEncrypted(out.text)) out.text = decrypt(ctx.keys.masterKey, out.text);
        if (coll === 'shares' || coll === 'copies') delete out.tokenHash;
        if (coll === 'copies' && isEncrypted(out.snapshotEnc)) { out.snapshot = JSON.parse(decrypt(ctx.keys.masterKey, out.snapshotEnc)); delete out.snapshotEnc; }
        lines.push(JSON.stringify({ collection: coll, ...out }));
      }
    }
    await audit({ actor: ownerActor(p.key._id), action: 'export', resource: '*', text: `Everything exported · ${lines.length} documents`, tone: 'owner' });
    reply.header('content-type', 'application/x-ndjson; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="little-dipper-export-${new Date().toISOString().slice(0, 10)}.jsonl"`);
    return lines.join('\n') + '\n';
  });

  app.post('/api/v1/node/recovery-kit', async (req, reply) => {
    const p = await requireSession(req);
    const { passphrase } = (req.body || {}) as { passphrase?: string };
    if (!passphrase || passphrase.length < 10) throw bad('weak_passphrase', 'Use a passphrase of at least 10 characters');
    const n = await getNode();
    const secret = JSON.stringify({ nodeId: n._id, signing: ctx.keys.signing, masterKey: ctx.keys.masterKey, keyHistory: n.keyHistory });
    const kit = { format: 'ldkit', v: 1, nodeId: n._id, createdAt: now(), contains: ['node signing key', 'backup decryption key'], ...encryptWithPassphrase(passphrase, secret) };
    await audit({ actor: ownerActor(p.key._id), action: 'node.recovery-kit', resource: 'nodes', text: 'You downloaded your recovery kit', tone: 'owner' });
    reply.header('content-disposition', `attachment; filename="little-dipper-${n._id}.ldkit"`);
    return kit;
  });

  // ── danger zone ──────────────────────────────────────────────────────
  app.post('/api/v1/node/transfer', async (req) => {
    const p = await requireSession(req);
    const link = await issueClaimLink('transfer');
    await audit({ actor: ownerActor(p.key._id), action: 'node.transfer', resource: 'nodes', text: 'You created an ownership transfer link', tone: 'owner' });
    return link;
  });

  app.post('/api/v1/node/reset', async (req, reply) => {
    await requireSession(req);
    const { confirm } = (req.body || {}) as { confirm?: string };
    if (confirm !== 'RESET') throw bad('confirm_required');
    await createBackup('pre-restore');
    for (const c of COLLECTIONS) if (!['nodes', 'backups'].includes(c)) await ctx.store.removeMany(c, {});
    const n = await getNode();
    await ctx.store.update('nodes', n._id, { claimed: false, ownerId: null, claimedAt: null });
    const { url } = await issueClaimLink();
    req.log.info(`Claim this node: ${url}`);
    console.log(`Claim this node: ${url}`);
    reply.clearCookie(COOKIE.session, { path: '/' });
    return { reset: true };
  });
}
