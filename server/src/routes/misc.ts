import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { audit, ownerActor } from '../audit.js';
import { bad, COOKIE, findKey, issueKey, notFound, requireOwner, SCOPES, type ApiKeyDoc } from '../auth.js';
import { allFields, plainValue } from '../fields.js';
import { canonicalUrl, getNode } from '../node.js';
import { sendSigned, tokenHash, type ContactDoc, type InviteDoc, type LinkDoc, type PublicProfileDoc } from '../federation.js';
import { endLink } from '../contacts.js';
import { listDomains } from '../domains/records.js';
import { getOwner } from '../owner.js';
import type { AuditDoc } from '../audit.js';

async function profileDoc() {
  const pp = await ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
  if (!pp) throw notFound('not_claimed');
  return pp;
}

async function publicFields(pp: PublicProfileDoc) {
  const fields = await allFields();
  return pp.fieldKeys
    .map((k) => fields.find((f) => f.key === k))
    .filter((f) => f && f.sensitivity !== 'secret' && plainValue(f))
    .map((f) => ({ key: f!.key, label: f!.label, value: plainValue(f!) }));
}

export default async function miscRoutes(app: FastifyInstance) {
  // ── public profile ───────────────────────────────────────────────────
  app.get('/public/v1/profile', async (req) => {
    const n = await getNode();
    if (!n.claimed) throw notFound('not_claimed');
    const pp = await profileDoc();
    // Count visitors, not the owner looking at their own page.
    if (!(await findKey(req.cookies[COOKIE.session], ['session']))) {
      const day = new Date().toISOString().slice(0, 10);
      await ctx.store.update('nodes', n._id, { publicViews: { day, count: n.publicViews?.day === day ? n.publicViews.count + 1 : 1 } });
    }
    const o = await getOwner();
    return {
      displayName: pp.displayName, headline: pp.headline, fields: await publicFields(pp),
      connectRequests: pp.connectRequests, address: canonicalUrl(n), ownerFirstName: (o?.displayName || pp.displayName).split(' ')[0],
    };
  });

  app.get('/public/v1/invites/:token', async (req) => {
    const { token } = req.params as { token: string };
    const [id, secret] = token.split('.');
    const inv = await ctx.store.get<InviteDoc>('invites', id || '');
    const n = await getNode();
    const pp = await ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
    const valid = !!inv && inv.tokenHash === tokenHash(secret || '') && !inv.usedByNodeId && new Date(inv.expiresAt).getTime() > Date.now();
    return { valid, displayName: pp?.displayName || null, address: canonicalUrl(n), expiresAt: valid ? inv!.expiresAt : null };
  });

  app.get('/api/v1/public-profile', async (req) => {
    await requireOwner(req, 'owner:read');
    const pp = await profileDoc();
    return { ...pp, fields: await publicFields(pp) };
  });

  app.put('/api/v1/public-profile', async (req) => {
    const p = await requireOwner(req, 'public:write');
    const pp = await profileDoc();
    const b = (req.body || {}) as Partial<Pick<PublicProfileDoc, 'displayName' | 'headline' | 'fieldKeys' | 'connectRequests'>>;
    const patch: Partial<PublicProfileDoc> = {};
    if (b.displayName !== undefined) patch.displayName = String(b.displayName).slice(0, 120);
    if (b.headline !== undefined) patch.headline = String(b.headline).slice(0, 280);
    if (b.fieldKeys) {
      const fields = await allFields();
      for (const k of b.fieldKeys) {
        const f = fields.find((x) => x.key === k);
        if (!f) throw bad('unknown_field', k);
        if (f.sensitivity === 'secret') throw bad('secret_never_public', `${f.label} is secret and can never be public`);
      }
      patch.fieldKeys = [...new Set(b.fieldKeys)];
    }
    if (b.connectRequests !== undefined) {
      if (!['off', 'fof', 'anyone'].includes(b.connectRequests)) throw bad('bad_connect_requests');
      patch.connectRequests = b.connectRequests;
    }
    await ctx.store.update('publicProfile', 'public', patch);
    const what = [
      patch.fieldKeys && 'visible fields', patch.connectRequests && 'connection requests', (patch.displayName !== undefined || patch.headline !== undefined) && 'header',
    ].filter(Boolean).join(', ');
    await audit({ actor: ownerActor(p.key._id), action: 'public.update', resource: 'publicProfile', text: `You changed your public profile (${what})`, tone: 'owner' });
    const out = await profileDoc();
    return { ...out, fields: await publicFields(out) };
  });

  // ── keys ─────────────────────────────────────────────────────────────
  app.get('/api/v1/keys', async (req) => {
    const p = await requireOwner(req, 'keys:manage');
    const all = await ctx.store.find<ApiKeyDoc>('apiKeys', { kind: { $in: ['session', 'app', 'peer'] } }, { sort: { createdAt: 1 } });
    const live = all.filter((k) => !k.revokedAt && (!k.expiresAt || new Date(k.expiresAt).getTime() > Date.now()));
    return {
      items: live.map((k) => ({
        id: k._id, name: k.kind === 'session' && k._id === p.key._id ? 'This browser' : k.name, kind: k.kind, prefix: k.prefix,
        scopes: k.scopes, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, current: k._id === p.key._id, contactId: k.contactId || null,
      })),
      scopes: SCOPES,
      domainScopes: (await listDomains()).map((d) => ({ domain: d.id, label: d.label, read: `${d.id}:read`, write: `${d.id}:write` })),
    };
  });

  app.post('/api/v1/keys', async (req, reply) => {
    const p = await requireOwner(req, 'keys:manage');
    const b = (req.body || {}) as { name?: string; scopes?: string[] };
    // Fixed scopes plus {domain}:read / {domain}:write for every domain in the catalog.
    const domainScopes = (await listDomains()).flatMap((d) => [`${d.id}:read`, `${d.id}:write`]);
    const valid = new Set<string>([...SCOPES, ...domainScopes]);
    const unknown = (b.scopes || []).filter((s) => !valid.has(s));
    if (unknown.length) throw bad('unknown_scope', `Unknown scope: ${unknown.join(', ')}`);
    const scopes = [...new Set(b.scopes || [])];
    if (!scopes.length) throw bad('scopes_required', 'Pick at least one scope');
    const name = String(b.name || '').trim() || 'New key';
    const { secret, doc } = await issueKey({ kind: 'app', name, scopes });
    await audit({ actor: ownerActor(p.key._id), action: 'key.create', resource: `apiKeys/${doc._id}`, text: `You created the API key “${name}”`, tone: 'owner' });
    reply.code(201);
    return { id: doc._id, name, scopes, prefix: doc.prefix, secret };
  });

  app.delete('/api/v1/keys/:id', async (req) => {
    const p = await requireOwner(req, 'keys:manage');
    const { id } = req.params as { id: string };
    const k = await ctx.store.get<ApiKeyDoc>('apiKeys', id);
    if (!k || k.revokedAt) throw notFound('key_not_found');
    if (k._id === p.key._id) throw bad('current_session', 'Sign out instead');
    if (k.kind === 'peer' && k.contactId) {
      // Revoking a peer token ends the connection; the contact stays in the list.
      const c = await ctx.store.get<ContactDoc>('contacts', k.contactId);
      const link = c?.node ? await ctx.store.get<LinkDoc>('nodeLinks', c.node.linkId) : null;
      if (link && link.status !== 'revoked') {
        try { await sendSigned(link.peerUrl, '/peer/v1/links/revoke', { type: 'link.revoke' }); } catch { /* best effort */ }
        await endLink(link, 'Disconnected');
      }
    }
    await ctx.store.update('apiKeys', k._id, { revokedAt: new Date().toISOString() });
    await audit({ actor: ownerActor(p.key._id), action: 'key.revoke', resource: `apiKeys/${k._id}`, text: `You revoked ${k.kind === 'peer' ? `${k.name}'s access` : `the key “${k.name}”`}`, tone: 'owner' });
    return { revoked: true };
  });

  // ── audit ────────────────────────────────────────────────────────────
  app.get('/api/v1/audit', async (req) => {
    await requireOwner(req, 'audit:read');
    const q = req.query as { limit?: string; before?: string; action?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    let items = await ctx.store.find<AuditDoc>('audit', q.action ? { action: q.action } : {}, { sort: { at: -1 } });
    if (q.before) items = items.filter((e) => e.at < q.before!);
    return { items: items.slice(0, limit) };
  });

}
