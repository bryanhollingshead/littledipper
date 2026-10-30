/**
 * Domain endpoints: one per category of personal data (/api/v1/data/employment, /api/v1/data/residences…),
 * plus the catalog that describes them and a cross-domain timeline.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ctx } from '../ctx.js';
import { audit, ownerActor } from '../audit.js';
import { bad, HttpError, notFound, requireOwner, requireSession } from '../auth.js';
import { contactsSharing, nudgePeers } from '../contacts.js';
import { documentsByRecord, recordRemoved } from '../documents.js';
import {
  buildRecord, checkCustomDomain, demoteOtherPrimaries, getDomain, isCurrent, listDomains, partSens, plainData,
  recordOut, recordsOf, sortRecords, syncDerived, DERIVED, type DomainDef, type RecordDoc, type RecordInput,
} from '../domains/records.js';

const DERIVED_DOMAINS = new Set(Object.values(DERIVED).map((x) => x.domain));
const readScopes = (d: string) => [`${d}:read`, 'records:read'];
const writeScopes = (d: string) => [`${d}:write`, 'records:write'];

async function domainOr404(id: string) {
  const d = await getDomain(id);
  if (!d) throw notFound('not_found');
  return d;
}

async function recordOr404(d: DomainDef, id: string) {
  const r = await ctx.store.get<RecordDoc & { [k: string]: unknown }>('records', id);
  if (!r || r.domain !== d.id) throw notFound('record_not_found');
  return r as RecordDoc;
}

/** Overlap filter for ?from=&to= on dated domains. */
function inRange(r: RecordDoc, from?: string, to?: string) {
  if (from && r.validTo && r.validTo < from) return false;
  if (to && r.validFrom && r.validFrom > to) return false;
  return true;
}

type Summary = { count: number; currentCount: number; preview: string[]; sharedWith: number };

/** Count, current count, a few masked titles and how many connections can read it: what the hub shows per category. */
async function summarize(domains: DomainDef[]): Promise<Record<string, Summary>> {
  const grants = await ctx.store.find<{ _id: string; contactId: string; domain?: string }>('grants', {});
  const activeContacts = new Set((await ctx.store.find<{ _id: string; contactId: string; status: string }>('nodeLinks', { status: 'active' })).map((l) => l.contactId));
  const out: Record<string, Summary> = {};
  for (const d of domains) {
    const recs = sortRecords(d, await recordsOf(d.id));
    out[d.id] = {
      count: recs.length,
      currentCount: recs.filter((r) => isCurrent(d, r)).length,
      preview: recs.slice(0, 3).map((r) => recordOut(d, r).title),
      sharedWith: grants.filter((g) => g.domain === d.id && activeContacts.has(g.contactId)).length,
    };
  }
  return out;
}

function catalogEntry(d: DomainDef, sum: Summary) {
  return {
    ...d,
    parts: d.parts.map((p) => ({ ...p, sensitivity: partSens(d, p) })),
    ...sum,
    scopes: { read: `${d.id}:read`, write: `${d.id}:write` },
    endpoint: `/api/v1/data/${d.id}`,
    feeds: Object.entries(DERIVED).filter(([, v]) => v.domain === d.id).map(([k]) => k),
  };
}

export default async function domainRoutes(app: FastifyInstance) {
  // ── catalog ──────────────────────────────────────────────────────────
  app.get('/api/v1/catalog', async (req) => {
    const p = await requireOwner(req, ['records:read', 'owner:read']);
    const domains = await listDomains();
    const visible = p.key.scopes.includes('admin:*') || p.key.scopes.includes('records:read')
      ? domains : domains.filter((d) => p.key.scopes.includes(`${d.id}:read`));
    const sums = await summarize(visible);
    return { domains: visible.map((d) => catalogEntry(d, sums[d.id])) };
  });

  app.post('/api/v1/catalog', async (req, reply) => {
    const p = await requireSession(req);
    const def = checkCustomDomain((req.body || {}) as Partial<DomainDef>);
    if (await getDomain(def.id)) throw new HttpError(409, 'exists', `You already have a category called ${def.label}`);
    await ctx.store.insert('domainDefs', { _id: def.id, ...def });
    await audit({ actor: ownerActor(p.key._id), action: 'domain.create', resource: `catalog/${def.id}`, text: `You created the category ${def.label}`, tone: 'owner' });
    reply.code(201);
    return catalogEntry(def, (await summarize([def]))[def.id]);
  });

  app.delete('/api/v1/catalog/:id', async (req) => {
    const p = await requireSession(req);
    const d = await domainOr404((req.params as { id: string }).id);
    if (d.builtIn) throw bad('built_in', 'Built-in categories can’t be removed');
    const n = await ctx.store.count('records', { domain: d.id });
    if (n && (req.query as { force?: string }).force !== '1') throw new HttpError(409, 'not_empty', `${d.label} still has ${n} entr${n === 1 ? 'y' : 'ies'}`);
    for (const r of await recordsOf(d.id)) await recordRemoved(r._id);
    await ctx.store.removeMany('records', { domain: d.id });
    await ctx.store.removeMany('grants', { domain: d.id });
    await ctx.store.remove('domainDefs', d.id);
    await audit({ actor: ownerActor(p.key._id), action: 'domain.delete', resource: `catalog/${d.id}`, text: `You removed the category ${d.label}`, tone: 'owner' });
    return { deleted: true };
  });

  // ── attention: documents and registrations expiring soon (or already) ─
  app.get('/api/v1/attention', async (req) => {
    await requireOwner(req, ['records:read']);
    const days = Math.min(730, Math.max(1, Number((req.query as { days?: string }).days) || 180));
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
    const items = [];
    for (const d of await listDomains()) {
      const dateParts = d.parts.filter((x) => x.type === 'date' && (x.remind || /expires/i.test(x.key)));
      if (!dateParts.length) continue;
      for (const r of await recordsOf(d.id)) {
        if (!isCurrent(d, r)) continue;
        const plain = plainData(r);
        for (const x of dateParts) {
          const v = plain[x.key] as string | undefined;
          if (!v) continue;
          // A partial date expires at the end of its period: 2027 → 2027-12-31, 2027-04 → 2027-04-30.
          const end = v.length === 4 ? `${v}-12-31` : v.length === 7 ? new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7), 0)).toISOString().slice(0, 10) : v;
          if (end > horizon) continue;
          // Deadlines (return by, warranty until) stop mattering soon after they pass; expired IDs keep nagging.
          if (x.remind && end < new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)) continue;
          items.push({ domain: d.id, domainLabel: d.label, id: r._id, title: recordOut(d, r).title, part: x.label, kind: x.remind ? 'deadline' : 'expiry', date: v, expired: end < today });
        }
      }
    }
    items.sort((a, b) => a.date.localeCompare(b.date));
    return { items, days };
  });

  // ── timeline: every dated record, across domains ─────────────────────
  app.get('/api/v1/timeline', async (req) => {
    await requireOwner(req, ['records:read']);
    const q = req.query as { from?: string; to?: string; domains?: string };
    const wanted = q.domains ? new Set(q.domains.split(',')) : null;
    const domains = (await listDomains()).filter((d) => d.dated && (!wanted || wanted.has(d.id)));
    const items = [];
    for (const d of domains) {
      for (const r of await recordsOf(d.id)) {
        if (!r.validFrom || !inRange(r, q.from, q.to)) continue;
        const out = recordOut(d, r);
        items.push({ domain: d.id, domainLabel: d.label, id: r._id, title: out.title, validFrom: r.validFrom, validTo: r.validTo, current: out.current });
      }
    }
    items.sort((a, b) => b.validFrom!.localeCompare(a.validFrom!));
    return { items };
  });

  // ── per-domain CRUD: /api/v1/data/{domain} ────────────────────────────
  // Records have their own prefix, so no fixed route can ever block a domain name.
  // The older /api/v1/{domain} paths are aliases until beta ships; nothing new should use them.
  // Registered last: every fixed /api/v1 route above or elsewhere wins over the alias parameters.
  const ctxFor = async (req: FastifyRequest, write: boolean) => {
    const { domain, id } = req.params as { domain: string; id?: string };
    const d = await domainOr404(domain);
    const p = await requireOwner(req, write ? writeScopes(d.id) : readScopes(d.id));
    return { d, p, id };
  };

  for (const base of ['/api/v1/data/:domain', '/api/v1/:domain']) {
    app.get(base, async (req) => {
      const { d } = await ctxFor(req, false);
      const q = req.query as { current?: string; from?: string; to?: string };
      let recs = sortRecords(d, await recordsOf(d.id));
      if (q.current === 'true') recs = recs.filter((r) => isCurrent(d, r));
      if (q.from || q.to) recs = recs.filter((r) => inRange(r, q.from, q.to));
      const docs = await documentsByRecord(d.id);
      return { domain: d.id, items: recs.map((r) => ({ ...recordOut(d, r), documents: docs.get(r._id) ?? [] })) };
    });

    app.post(base, async (req, reply) => {
      const { d, p } = await ctxFor(req, true);
      const rec = await buildRecord(d, (req.body || {}) as RecordInput, null, { type: p.isSession ? 'owner' : 'app', id: p.key._id });
      await ctx.store.insert('records', rec);
      await demoteOtherPrimaries(rec);
      await syncDerived(d.id);
      const out = recordOut(d, rec);
      nudgePeers(DERIVED_DOMAINS.has(d.id) ? null : await contactsSharing(d.id));
      await audit({ actor: ownerActor(p.key._id), action: 'record.create', resource: `${d.id}/${rec._id}`, text: `${p.isSession ? 'You' : 'An app'} added ${out.title} to ${d.label}`, tone: 'owner' });
      reply.code(201);
      return out;
    });

    app.get(`${base}/:id`, async (req) => {
      const { d, id } = await ctxFor(req, false);
      const r = await recordOr404(d, id!);
      return { ...recordOut(d, r), documents: (await documentsByRecord(d.id)).get(r._id) ?? [] };
    });

    app.patch(`${base}/:id`, async (req) => {
      const { d, p, id } = await ctxFor(req, true);
      const existing = await recordOr404(d, id!);
      const rec = await buildRecord(d, (req.body || {}) as RecordInput, existing, existing.source);
      const { _id, ...rest } = rec;
      // Replace data wholesale so removed parts really go.
      await ctx.store.update('records', _id, { ...rest });
      await demoteOtherPrimaries(rec);
      await syncDerived(d.id);
      const out = recordOut(d, rec);
      nudgePeers(DERIVED_DOMAINS.has(d.id) ? null : await contactsSharing(d.id));
      await audit({ actor: ownerActor(p.key._id), action: 'record.update', resource: `${d.id}/${_id}`, text: `${p.isSession ? 'You' : 'An app'} updated ${out.title} in ${d.label}`, tone: 'owner' });
      return out;
    });

    app.delete(`${base}/:id`, async (req) => {
      const { d, p, id } = await ctxFor(req, true);
      const r = await recordOr404(d, id!);
      const title = recordOut(d, r).title;
      await ctx.store.remove('records', r._id);
      const docsDeleted = await recordRemoved(r._id);
      await syncDerived(d.id);
      nudgePeers(DERIVED_DOMAINS.has(d.id) ? null : await contactsSharing(d.id));
      await audit({ actor: ownerActor(p.key._id), action: 'record.delete', resource: `${d.id}/${r._id}`, text: `${p.isSession ? 'You' : 'An app'} removed ${title} from ${d.label}`, tone: 'owner' });
      return { deleted: true, documentsDeleted: docsDeleted };
    });

    app.post(`${base}/:id/reveal`, async (req) => {
      const { d, p, id } = await ctxFor(req, false);
      const r = await recordOr404(d, id!);
      const out = recordOut(d, r, { reveal: true });
      await audit({ actor: ownerActor(p.key._id), action: 'record.reveal', resource: `${d.id}/${r._id}`, text: `${p.isSession ? 'You' : 'An app'} revealed ${recordOut(d, r).title} (${d.label})`, tone: 'owner', ip: req.ip });
      return out;
    });
  }
}
