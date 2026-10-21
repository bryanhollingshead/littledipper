import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { newId } from '../crypto.js';
import { audit, ownerActor } from '../audit.js';
import { bad, HttpError, notFound, requireOwner, requireSession } from '../auth.js';
import { allFields, fieldOut, plainValue, SECTIONS, SENSITIVITIES, slugKey, storeValue, type FieldDoc, type Sensitivity } from '../fields.js';
import { getOwner } from '../owner.js';
import { nudgePeers } from '../contacts.js';
import { grantsFor, type LinkDoc, type PublicProfileDoc } from '../federation.js';

/** For each field: how many connected contacts can read it right now. */
async function sharingCounts(fields: FieldDoc[]) {
  const links = await ctx.store.find<LinkDoc>('nodeLinks', { status: 'active' });
  const grants = await Promise.all(links.map((l) => grantsFor(l.contactId)));
  const basicN = grants.filter((g) => g.profile).length;
  const counts = Object.fromEntries(fields.map((f) => [f.key, f.sensitivity === 'standard' ? grants.filter((g) => g.profile || g.fields.includes(f.key)).length : grants.filter((g) => g.fields.includes(f.key)).length]));
  return { counts, basicN };
}

export default async function ownerRoutes(app: FastifyInstance) {
  app.get('/api/v1/owner', async (req) => {
    const p = await requireOwner(req, 'owner:read');
    const o = (await getOwner())!;
    const fields = await allFields();
    return {
      id: o._id, displayName: o.displayName, email: o.email, prefs: o.prefs,
      role: p.key.scopes.includes('admin:*') ? 'admin:*' : p.key.scopes.join(' '),
      fields: fields.map((f) => fieldOut(f)),
    };
  });

  app.patch('/api/v1/owner', async (req) => {
    const p = await requireOwner(req, 'owner:write');
    const o = (await getOwner())!;
    const body = (req.body || {}) as { displayName?: string; email?: string; prefs?: { showTechnical?: boolean } };
    const patch: Record<string, unknown> = {};
    if (body.displayName !== undefined) {
      if (!String(body.displayName).trim()) throw bad('name_required');
      patch.displayName = String(body.displayName).trim();
    }
    if (body.email !== undefined) patch.email = String(body.email).trim();
    if (body.prefs) {
      if (!p.isSession) throw bad('session_required');
      patch.prefs = { ...o.prefs, ...body.prefs };
    }
    await ctx.store.update('owners', o._id, patch);
    const out = (await getOwner())!;
    return { id: out._id, displayName: out.displayName, email: out.email, prefs: out.prefs };
  });

  app.get('/api/v1/owner/fields', async (req) => {
    await requireOwner(req, 'owner:read');
    const q = req.query as { section?: string; sensitivity?: string };
    const fields = (await allFields()).filter((f) => (!q.section || f.section === q.section) && (!q.sensitivity || f.sensitivity === q.sensitivity));
    const pp = await ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
    const { counts, basicN } = await sharingCounts(fields);
    return {
      items: fields.map((f) => ({ ...fieldOut(f), public: f.sensitivity !== 'secret' && !!pp?.fieldKeys.includes(f.key), sharedWith: counts[f.key] || 0 })),
      basicProfileContacts: basicN,
    };
  });

  app.post('/api/v1/owner/fields', async (req, reply) => {
    const p = await requireOwner(req, 'owner:write');
    const body = (req.body || {}) as { label?: string; value?: string; sensitivity?: Sensitivity; section?: FieldDoc['section'] };
    const label = String(body.label || '').trim();
    if (!label) throw bad('label_required', 'Give the field a name');
    const sensitivity = SENSITIVITIES.includes(body.sensitivity as Sensitivity) ? (body.sensitivity as Sensitivity) : 'sensitive';
    const section = SECTIONS.includes(body.section as never) ? (body.section as FieldDoc['section']) : 'custom';
    let key = slugKey(label);
    for (let i = 2; await ctx.store.findOne('fields', { key }); i++) key = `${slugKey(label)}_${i}`;
    const order = (await ctx.store.count('fields')) + 1;
    const f: FieldDoc = { _id: newId('fld'), key, label, section, type: 'text', value: storeValue(String(body.value || ''), sensitivity), sensitivity, order, updatedAt: new Date().toISOString() };
    await ctx.store.insert('fields', f);
    nudgePeers(null);
    await audit({ actor: ownerActor(p.key._id), action: 'field.create', resource: `fields/${key}`, text: `You added ${label}`, tone: 'owner' });
    reply.code(201);
    return fieldOut(f);
  });

  app.put('/api/v1/owner/fields/:key', async (req) => {
    const p = await requireOwner(req, 'owner:write');
    const { key } = req.params as { key: string };
    const f = await ctx.store.findOne<FieldDoc>('fields', { key });
    if (!f) throw notFound('field_not_found');
    const body = (req.body || {}) as { value?: string; sensitivity?: Sensitivity; label?: string };
    if (f.derivedFrom && body.value !== undefined && body.value !== plainValue(f)) {
      throw new HttpError(409, 'derived_field', `${f.label} comes from ${f.derivedFrom === 'residences' ? 'Residences' : 'Contact methods'}. Change it there.`);
    }
    const sens = body.sensitivity && SENSITIVITIES.includes(body.sensitivity) ? body.sensitivity : f.sensitivity;
    const value = body.value !== undefined ? String(body.value) : plainValue(f);
    await ctx.store.update('fields', f._id, { value: storeValue(value, sens), sensitivity: sens, label: body.label?.trim() || f.label, updatedAt: new Date().toISOString() });
    if (sens === 'secret') {
      // Secret fields are never public.
      const pp = await ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
      if (pp?.fieldKeys.includes(key)) await ctx.store.update('publicProfile', 'public', { fieldKeys: pp.fieldKeys.filter((k) => k !== key) });
    }
    nudgePeers(null);
    await audit({ actor: ownerActor(p.key._id), action: 'field.update', resource: `fields/${key}`, text: `You updated ${body.label?.trim() || f.label}${sens !== f.sensitivity ? ` · now ${sens}` : ''}`, tone: 'owner' });
    return fieldOut((await ctx.store.get<FieldDoc>('fields', f._id))!);
  });

  app.delete('/api/v1/owner/fields/:key', async (req) => {
    const p = await requireSession(req);
    const { key } = req.params as { key: string };
    const f = await ctx.store.findOne<FieldDoc>('fields', { key });
    if (!f) throw notFound('field_not_found');
    await ctx.store.remove('fields', f._id);
    await ctx.store.removeMany('grants', { fieldKey: key });
    const pp = await ctx.store.get<PublicProfileDoc>('publicProfile', 'public');
    if (pp?.fieldKeys.includes(key)) await ctx.store.update('publicProfile', 'public', { fieldKeys: pp.fieldKeys.filter((k) => k !== key) });
    nudgePeers(null);
    await audit({ actor: ownerActor(p.key._id), action: 'field.delete', resource: `fields/${key}`, text: `You removed ${f.label}`, tone: 'owner' });
    return { deleted: true };
  });

  app.post('/api/v1/owner/fields/:key/reveal', async (req) => {
    const p = await requireOwner(req, 'owner:read');
    const { key } = req.params as { key: string };
    const f = await ctx.store.findOne<FieldDoc>('fields', { key });
    if (!f) throw notFound('field_not_found');
    await audit({ actor: ownerActor(p.key._id), action: 'field.reveal', resource: `fields/${key}`, text: `You revealed ${f.label}`, tone: 'owner', ip: req.ip });
    return { key, value: plainValue(f) };
  });
}
