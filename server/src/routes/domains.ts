/**
 * Domain endpoints: one per category of personal data (/api/data/employment, /api/data/residences…),
 * plus the catalog that describes them and a cross-domain timeline.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ctx } from '../ctx.js';
import { audit, ownerActor } from '../audit.js';
import { bad, HttpError, notFound, requireOwner, requireSession, type ApiKeyDoc } from '../auth.js';
import { isIdentityChange, pendingReply, propose, reviewInput, type ReviewDoc } from '../reviews.js';
import { mask } from '../fields.js';
import { undoOnRecord } from '../undo.js';
import { contactsSharing, nudgePeers } from '../contacts.js';
import { documentsByRecord, recordRemoved } from '../documents.js';
import { isDateTime } from '../domains/datetime.js';
import {
  actorLabels, buildRecord, checkCustomDomain, deletedRecords, KEEP_DELETED_DAYS, recordVersion, versionRecord, versionsOf, demoteOtherPrimaries, getDomain, isCurrent, listDomains, partSens, plainData,
  recordOut, recordsOf, sortRecords, syncDerived, DERIVED, type DomainDef, type RecordDoc, type RecordInput,
} from '../domains/records.js';
import type { Actor, VersionDoc } from '../domains/types.js';

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
    endpoint: `/api/data/${d.id}`,
    feeds: Object.entries(DERIVED).filter(([, v]) => v.domain === d.id).map(([k]) => k),
  };
}

/** Who made a change, for the activity feed: "You", or the app or assistant's name. */
const actorName = (p: { isSession: boolean; key: { name: string } }) => (p.isSession ? 'You' : p.key.name);

/** Secret parts an input sets (a value, not a removal). */
const secretKeys = (d: DomainDef, input: RecordInput) =>
  Object.entries(input.data ?? {}).filter(([k, v]) => v !== null && v !== undefined && v !== '' && d.parts.some((x) => x.key === k && partSens(d, x) === 'secret')).map(([k]) => k);

async function proposeChange(p: { key: ApiKeyDoc }, d: DomainDef, recordId: string | null, input: RecordInput, reason: ReviewDoc['reason']) {
  const r = await propose(p.key, d.id, recordId, input, reason);
  await audit({ actor: ownerActor(p.key._id), action: 'review.propose', resource: `reviews/${r._id}`, text: `${p.key.name} suggested ${recordId ? 'a change to' : 'a new entry in'} ${d.label}. It's waiting for you in Review.`, tone: 'request' });
  return r;
}

export async function createRecord(d: DomainDef, input: RecordInput, by: Actor, who: string) {
  const rec = await buildRecord(d, input, null, by);
  await ctx.store.insert('records', rec);
  await recordVersion(rec, 'create', by);
  await demoteOtherPrimaries(rec);
  await syncDerived(d.id);
  const out = { ...recordOut(d, rec), updatedByLabel: (await actorLabels())(by) };
  nudgePeers(DERIVED_DOMAINS.has(d.id) ? null : await contactsSharing(d.id));
  await audit({ actor: ownerActor(by.id), action: 'record.create', resource: `${d.id}/${rec._id}`, text: `${who} added ${out.title} to ${d.label}`, tone: 'owner' });
  return out;
}

export async function updateRecord(d: DomainDef, existing: RecordDoc, input: RecordInput, by: Actor, who: string) {
  const rec = await buildRecord(d, input, existing, by);
  const { _id, ...rest } = rec;
  // Replace data wholesale so removed parts really go.
  await ctx.store.update('records', _id, { ...rest });
  await recordVersion(rec, 'update', by);
  await demoteOtherPrimaries(rec);
  await syncDerived(d.id);
  const out = { ...recordOut(d, rec), updatedByLabel: (await actorLabels())(by) };
  nudgePeers(DERIVED_DOMAINS.has(d.id) ? null : await contactsSharing(d.id));
  await audit({ actor: ownerActor(by.id), action: 'record.update', resource: `${d.id}/${_id}`, text: `${who} updated ${out.title} in ${d.label}`, tone: 'owner' });
  return out;
}

export default async function domainRoutes(app: FastifyInstance) {
  // ── catalog ──────────────────────────────────────────────────────────
  app.get('/api/catalog', async (req) => {
    // Any key that can read a kind sees that kind's entry (an assistant learns its fields here).
    const domains = await listDomains();
    const p = await requireOwner(req, ['records:read', 'owner:read', ...domains.map((d) => `${d.id}:read`)]);
    const visible = p.key.scopes.includes('admin:*') || p.key.scopes.includes('records:read')
      ? domains : domains.filter((d) => p.key.scopes.includes(`${d.id}:read`));
    const sums = await summarize(visible);
    return { domains: visible.map((d) => catalogEntry(d, sums[d.id])) };
  });

  app.post('/api/catalog', async (req, reply) => {
    const p = await requireSession(req);
    const def = checkCustomDomain((req.body || {}) as Partial<DomainDef>);
    if (await getDomain(def.id)) throw new HttpError(409, 'exists', `You already have a category called ${def.label}`);
    await ctx.store.insert('domainDefs', { _id: def.id, ...def });
    await audit({ actor: ownerActor(p.key._id), action: 'domain.create', resource: `catalog/${def.id}`, text: `You created the category ${def.label}`, tone: 'owner' });
    reply.code(201);
    return catalogEntry(def, (await summarize([def]))[def.id]);
  });

  app.delete('/api/catalog/:id', async (req) => {
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
  app.get('/api/attention', async (req) => {
    await requireOwner(req, ['records:read']);
    const days = Math.min(730, Math.max(1, Number((req.query as { days?: string }).days) || 180));
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
    const items = [];
    for (const d of await listDomains()) {
      const dateParts = d.parts.filter((x) => (x.type === 'date' || x.type === 'datetime') && (x.remind || /expires/i.test(x.key)));
      if (!dateParts.length) continue;
      for (const r of await recordsOf(d.id)) {
        if (!isCurrent(d, r)) continue;
        const plain = plainData(r);
        for (const x of dateParts) {
          const raw = plain[x.key];
          if (!raw) continue;
          // A datetime counts by its local date; clients that know the type also get the moment itself.
          const v = isDateTime(raw) ? raw.at.slice(0, 10) : String(raw);
          // A partial date expires at the end of its period: 2027 → 2027-12-31, 2027-04 → 2027-04-30.
          const end = v.length === 4 ? `${v}-12-31` : v.length === 7 ? new Date(Date.UTC(+v.slice(0, 4), +v.slice(5, 7), 0)).toISOString().slice(0, 10) : v;
          if (end > horizon) continue;
          // Deadlines (return by, warranty until) stop mattering soon after they pass; expired IDs keep nagging.
          if (x.remind && end < new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)) continue;
          items.push({ domain: d.id, domainLabel: d.label, id: r._id, title: recordOut(d, r).title, part: x.label, kind: x.remind ? 'deadline' : 'expiry', date: v, ...(isDateTime(raw) ? { datetime: raw } : {}), expired: end < today });
        }
      }
    }
    items.sort((a, b) => a.date.localeCompare(b.date));
    return { items, days };
  });

  // ── timeline: every dated record, across domains ─────────────────────
  app.get('/api/timeline', async (req) => {
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

  // ── per-domain CRUD: /api/data/{domain} ────────────────────────────
  // Records have their own prefix, so no fixed route can ever block a domain name.
  const ctxFor = async (req: FastifyRequest, write: boolean) => {
    const { domain, id } = req.params as { domain: string; id?: string };
    const d = await domainOr404(domain);
    // Record writes are reviewable: an assistant's change goes to Review when its mode or the change calls for it.
    const p = await requireOwner(req, write ? writeScopes(d.id) : readScopes(d.id), { reviewable: write });
    const by: Actor = { type: p.isSession ? 'owner' : 'app', id: p.key._id };
    return { d, p, id, by };
  };

  const base = '/api/data/:domain';
  app.get(base, async (req) => {
    const { d } = await ctxFor(req, false);
    const q = req.query as { current?: string; from?: string; to?: string };
    let recs = sortRecords(d, await recordsOf(d.id));
    if (q.current === 'true') recs = recs.filter((r) => isCurrent(d, r));
    if (q.from || q.to) recs = recs.filter((r) => inRange(r, q.from, q.to));
    const docs = await documentsByRecord(d.id);
    const label = await actorLabels();
    return { domain: d.id, items: recs.map((r) => { const out = recordOut(d, r); return { ...out, updatedByLabel: label(out.updatedBy), sourceLabel: label(out.source), documents: docs.get(r._id) ?? [] }; }) };
  });

  app.post(base, async (req, reply) => {
    const { d, p, by } = await ctxFor(req, true);
    const input = (req.body || {}) as RecordInput;
    const a = p.key.assistant;
    if (a) {
      // Check it now, so the assistant hears about a mistake straight away rather than at approval.
      await buildRecord(d, input, null, by);
      const reason = a.mode === 'suggest' ? 'suggest' : isIdentityChange(d, input, null) ? 'identity' : secretKeys(d, input).length ? 'secret' : null;
      if (reason) { reply.code(202); return pendingReply(await proposeChange(p, d, null, input, reason)); }
    }
    reply.code(201);
    return createRecord(d, input, by, actorName(p));
  });

  app.get(`${base}/:id`, async (req) => {
    const { d, id } = await ctxFor(req, false);
    const r = await recordOr404(d, id!);
    const out = recordOut(d, r);
    const label = await actorLabels();
    return { ...out, updatedByLabel: label(out.updatedBy), sourceLabel: label(out.source), documents: (await documentsByRecord(d.id)).get(r._id) ?? [] };
  });

  app.patch(`${base}/:id`, async (req, reply) => {
    const { d, p, id, by } = await ctxFor(req, true);
    const existing = await recordOr404(d, id!);
    const input = (req.body || {}) as RecordInput;
    const a = p.key.assistant;
    if (a) {
      await buildRecord(d, input, existing, by);
      if (a.mode === 'suggest') { reply.code(202); return pendingReply(await proposeChange(p, d, existing._id, input, 'suggest')); }
      if (isIdentityChange(d, input, existing)) { reply.code(202); return pendingReply(await proposeChange(p, d, existing._id, input, 'identity')); }
      // Make changes: everything else goes in except secret values, which wait in Review.
      const secrets = secretKeys(d, input);
      if (secrets.length) {
        const review = await proposeChange(p, d, existing._id, { data: Object.fromEntries(secrets.map((k) => [k, input.data![k]])) }, 'secret');
        const rest: RecordInput = { ...input, data: Object.fromEntries(Object.entries(input.data!).filter(([k]) => !secrets.includes(k))) };
        const saved = await updateRecord(d, existing, rest, by, actorName(p));
        return { ...saved, pendingReview: pendingReply(review) };
      }
    }
    return updateRecord(d, existing, input, by, actorName(p));
  });

  app.delete(`${base}/:id`, async (req) => {
    const { d, p, id, by } = await ctxFor(req, true);
    if (p.key.assistant) throw new HttpError(403, 'owner_only', 'Only the owner deletes. Tell them what to remove.');
    const r = await recordOr404(d, id!);
    const title = recordOut(d, r).title;
    await recordVersion(r, 'delete', by);
    await ctx.store.remove('records', r._id);
    const docsDeleted = await recordRemoved(r._id);
    await syncDerived(d.id);
    nudgePeers(DERIVED_DOMAINS.has(d.id) ? null : await contactsSharing(d.id));
    await audit({ actor: ownerActor(p.key._id), action: 'record.delete', resource: `${d.id}/${r._id}`, text: `${actorName(p)} removed ${title} from ${d.label}`, tone: 'owner' });
    return { deleted: true, documentsDeleted: docsDeleted, restorableForDays: KEEP_DELETED_DAYS };
  });

  app.post(`${base}/:id/reveal`, async (req) => {
    const { d, p, id } = await ctxFor(req, false);
    const r = await recordOr404(d, id!);
    const a = p.key.assistant;
    const out = recordOut(d, r, { reveal: a ? new Set(a.secretFields.filter((f) => f.startsWith(`${d.id}.`)).map((f) => f.slice(d.id.length + 1))) : true });
    await audit({ actor: ownerActor(p.key._id), action: 'record.reveal', resource: `${d.id}/${r._id}`, text: `${actorName(p)} revealed ${recordOut(d, r).title} (${d.label})`, tone: 'owner', ip: req.ip });
    return out;
  });

  // ── history: /api/data/{domain}/{id}/history ───────────────────────
  // Owner-facing only (same scopes as the record); contacts and peers see current values, never history.
  const versionOut = (d: DomainDef, v: VersionDoc, label: (a: Actor) => string) => ({
    version: v._id, action: v.action, at: v.at, by: v.by, byLabel: label(v.by), record: recordOut(d, versionRecord(v)),
  });

  app.get('/api/data/:domain/deleted', async (req) => {
    const { d } = await ctxFor(req, false);
    const label = await actorLabels();
    return { domain: d.id, keepDays: KEEP_DELETED_DAYS, items: (await deletedRecords(d.id)).map((v) => versionOut(d, v, label)) };
  });

  app.get('/api/data/:domain/:id/history', async (req) => {
    const { d, id } = await ctxFor(req, false);
    const versions = (await versionsOf(id!)).filter((v) => v.domain === d.id);
    if (!versions.length && !(await ctx.store.get('records', id!))) throw notFound('record_not_found');
    const label = await actorLabels();
    return { recordId: id, deleted: !(await ctx.store.get('records', id!)), items: versions.map((v) => versionOut(d, v, label)) };
  });

  /** Make an earlier version current again, as a new change (or bring a deleted record back). Nothing is rewritten. */
  app.post('/api/data/:domain/:id/history/:version/restore', async (req) => {
    const { d, p, id, by } = await ctxFor(req, true);
    if (p.key.assistant) throw new HttpError(403, 'owner_only', 'Only the owner restores earlier versions.');
    const { version } = req.params as { version: string };
    const v = await ctx.store.get<VersionDoc>('recordVersions', version);
    if (!v || v.recordId !== id || v.domain !== d.id) throw notFound('version_not_found');
    const existing = await ctx.store.get<RecordDoc>('records', id!);
    const rec: RecordDoc = { ...versionRecord(v), updatedBy: by, updatedAt: new Date().toISOString() };
    if (existing) { const { _id, ...rest } = rec; await ctx.store.update('records', _id, { ...rest }); }
    else await ctx.store.insert('records', rec);
    await recordVersion(rec, 'restore', by);
    await demoteOtherPrimaries(rec);
    await syncDerived(d.id);
    nudgePeers(DERIVED_DOMAINS.has(d.id) ? null : await contactsSharing(d.id));
    const out = { ...recordOut(d, rec), updatedByLabel: (await actorLabels())(by) };
    await audit({ actor: ownerActor(p.key._id), action: 'record.restore', resource: `${d.id}/${id}`, text: `${actorName(p)} ${existing ? 'restored an earlier version of' : 'brought back'} ${out.title} in ${d.label}`, tone: 'owner' });
    return out;
  });

  /** Undo one change an app or assistant made, field by field (never over a later edit). */
  app.post('/api/data/:domain/:id/history/:version/undo', async (req) => {
    const p = await requireSession(req);
    const { domain, id, version } = req.params as { domain: string; id: string; version: string };
    const v = await ctx.store.get<VersionDoc>('recordVersions', version);
    if (!v || v.recordId !== id || v.domain !== domain) throw notFound('version_not_found');
    if (v.by.type !== 'app') throw bad('not_an_app_change', 'Only changes made by apps and assistants can be undone this way. Restore an earlier version instead.');
    const result = await undoOnRecord(id, [v], v.by.id, { type: 'owner', id: p.key._id });
    if (result.outcome === 'reverted' || result.outcome === 'removed') {
      nudgePeers(DERIVED_DOMAINS.has(domain) ? null : await contactsSharing(domain));
      await audit({ actor: ownerActor(p.key._id), action: 'undo.change', resource: `${domain}/${id}`, text: `You undid a change to ${result.title}`, tone: 'owner' });
    }
    return result;
  });

  // ── review: changes assistants proposed, waiting for the owner ─────────
  // The owner sees every item; an assistant's key sees its own (secret values masked).
  const reviewOut = async (r: ReviewDoc, owner: boolean) => {
    const d = await getDomain(r.domain);
    const input = reviewInput(r);
    const current = r.recordId ? await ctx.store.get<RecordDoc>('records', r.recordId) : null;
    const plainNow = current ? plainData(current) : {};
    const show = (k: string, v: unknown) => (!owner && d?.parts.some((x) => x.key === k && partSens(d, x) === 'secret') ? mask(String(v)) : v);
    return {
      id: r._id, by: r.by, keyId: r.keyId, domain: r.domain, domainLabel: d?.label ?? r.domain, recordId: r.recordId,
      recordTitle: d && current ? recordOut(d, current).title : null, recordGone: !!r.recordId && !current,
      action: r.action, reason: r.reason, status: r.status, createdAt: r.createdAt, decidedAt: r.decidedAt, resultId: r.resultId ?? null,
      changes: [
        ...Object.entries(input.data ?? {}).map(([k, v]) => {
          const part = d?.parts.find((x) => x.key === k);
          const secret = !!(d && part && partSens(d, part) === 'secret');
          return { key: k, label: part?.label ?? k, secret, to: show(k, v), from: r.recordId && owner ? (plainNow[k] ?? null) : undefined };
        }),
        ...(['validFrom', 'validTo', 'notes'] as const).filter((k) => input[k] !== undefined).map((k) => ({
          key: k, label: { validFrom: 'From', validTo: 'To', notes: 'Notes' }[k], secret: false, to: input[k], from: current && owner ? current[k] ?? null : undefined,
        })),
      ],
    };
  };

  app.get('/api/reviews', async (req) => {
    const p = await requireOwner(req, ['records:read', 'records:write', ...(await listDomains()).flatMap((d) => [`${d.id}:read`, `${d.id}:write`])]);
    const q = req.query as { status?: string };
    const status = q.status === 'all' ? null : q.status || 'pending';
    let items = await ctx.store.find<ReviewDoc>('reviews', status ? { status } : {}, { sort: { createdAt: -1 } });
    if (!p.isSession) items = items.filter((r) => r.keyId === p.key._id);
    return { items: await Promise.all(items.slice(0, 200).map((r) => reviewOut(r, p.isSession))) };
  });

  const reviewOr404 = async (id: string) => {
    const r = await ctx.store.get<ReviewDoc>('reviews', id);
    if (!r) throw notFound('review_not_found');
    if (r.status !== 'pending') throw new HttpError(409, 'already_decided', `This was already ${r.status}.`);
    return r;
  };

  /** Approve: the change is saved now, credited to the assistant that proposed it. */
  app.post('/api/reviews/:id/approve', async (req) => {
    const p = await requireSession(req);
    const r = await reviewOr404((req.params as { id: string }).id);
    const d = await domainOr404(r.domain);
    const by: Actor = { type: 'app', id: r.keyId };
    let saved;
    if (r.recordId) {
      const existing = await ctx.store.get<RecordDoc>('records', r.recordId);
      if (!existing) throw new HttpError(409, 'record_gone', 'That entry was deleted since. Reject this suggestion instead.');
      saved = await updateRecord(d, existing, reviewInput(r), by, `${r.by} (approved by you)`);
    } else saved = await createRecord(d, reviewInput(r), by, `${r.by} (approved by you)`);
    await ctx.store.update('reviews', r._id, { status: 'approved', decidedAt: new Date().toISOString(), resultId: saved.id });
    await audit({ actor: ownerActor(p.key._id), action: 'review.approve', resource: `reviews/${r._id}`, text: `You approved ${r.by}'s suggestion for ${d.label}`, tone: 'owner' });
    return { ...(await reviewOut({ ...r, status: 'approved', decidedAt: new Date().toISOString(), resultId: saved.id }, true)), record: saved };
  });

  app.post('/api/reviews/:id/reject', async (req) => {
    const p = await requireSession(req);
    const r = await reviewOr404((req.params as { id: string }).id);
    await ctx.store.update('reviews', r._id, { status: 'rejected', decidedAt: new Date().toISOString() });
    await audit({ actor: ownerActor(p.key._id), action: 'review.reject', resource: `reviews/${r._id}`, text: `You turned down ${r.by}'s suggestion`, tone: 'owner' });
    return reviewOut({ ...r, status: 'rejected', decidedAt: new Date().toISOString() }, true);
  });
}
