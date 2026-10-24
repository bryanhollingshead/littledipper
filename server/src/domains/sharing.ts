/** What a connected contact may read from a domain (or a copy holds), shaped for display on their side. */
import { ctx } from '../ctx.js';
import { grantsFor } from '../federation.js';
import { displayValue, getDomain, isCurrent, partSens, plainData, recordsOf, renderTitle, sortRecords, type DomainDef, type RecordDoc } from './records.js';

export type SharedRecord = {
  id: string;
  title: string;
  /** rows: one line per row of a list part (a receipt's items). */
  fields: { key: string; label: string; value: string; rows?: string[] }[];
  /** Raw values for machine use (no contact ids, no notes). */
  data: Record<string, unknown>;
  validFrom: string | null;
  validTo: string | null;
  current: boolean;
  updatedAt: string;
};
export type SharedDomain = { domain: string; label: string; scope: 'all' | 'current'; records: SharedRecord[] };

export async function sharedDomainOut(contactId: string, domainId: string): Promise<SharedDomain | null> {
  const g = (await grantsFor(contactId)).domains[domainId];
  const d = await getDomain(domainId);
  if (!g || !d) return null;
  const recs = sortRecords(d, await recordsOf(d.id)).filter((r) => g.scope === 'all' || isCurrent(d, r));
  return { domain: d.id, label: d.label, scope: g.scope, records: await shapeRecords(d, recs, g.includeSecret) };
}

/** Records as someone else sees them: no notes, secret parts only with includeSecret, contacts as names. */
export async function shapeRecords(d: DomainDef, recs: RecordDoc[], includeSecret: boolean): Promise<SharedRecord[]> {
  const names = new Map<string, string>();
  const nameOf = async (id: string) => {
    if (!names.has(id)) names.set(id, (await ctx.store.get('contacts', id))?.displayName ?? '');
    return names.get(id)!;
  };
  const hidden = new Set(d.parts.filter((p) => partSens(d, p) === 'secret' && !includeSecret).map((p) => p.key));
  const out: SharedRecord[] = [];
  for (const r of recs) {
    const plain = plainData(r);
    const fields: SharedRecord['fields'] = [];
    const data: Record<string, unknown> = {};
    for (const p of d.parts) {
      if (hidden.has(p.key) || plain[p.key] === undefined) continue;
      // A contact link becomes the person's name: their record ids mean nothing elsewhere.
      const value = p.type === 'contact' ? await nameOf(String(plain[p.key])) : displayValue(p, plain[p.key]);
      if (!value) continue;
      const rows = p.type === 'list' ? (plain[p.key] as Record<string, unknown>[]).map((row) => p.of!.map((s) => displayValue(s, row[s.key])).filter(Boolean).join(' · ')) : undefined;
      fields.push({ key: p.key, label: p.label, value, ...(rows ? { rows } : {}) });
      data[p.key] = p.type === 'contact' ? value : plain[p.key];
    }
    out.push({ id: r._id, title: renderTitle(d, plain, hidden), fields, data, validFrom: r.validFrom, validTo: r.validTo, current: isCurrent(d, r), updatedAt: r.updatedAt });
  }
  return out;
}
