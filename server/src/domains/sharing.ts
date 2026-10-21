/** What a connected contact may read from a domain, shaped for display on their side. */
import { ctx } from '../ctx.js';
import { grantsFor } from '../federation.js';
import { displayValue, getDomain, isCurrent, partSens, plainData, recordsOf, renderTitle, sortRecords } from './records.js';

export type SharedRecord = {
  id: string;
  title: string;
  fields: { key: string; label: string; value: string }[];
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
  const names = new Map<string, string>();
  const nameOf = async (id: string) => {
    if (!names.has(id)) names.set(id, (await ctx.store.get('contacts', id))?.displayName ?? '');
    return names.get(id)!;
  };
  const recs = sortRecords(d, await recordsOf(d.id)).filter((r) => g.scope === 'all' || isCurrent(d, r));
  const out: SharedRecord[] = [];
  for (const r of recs) {
    const plain = plainData(r);
    const hidden = new Set(d.parts.filter((p) => partSens(d, p) === 'secret' && !g.includeSecret).map((p) => p.key));
    const fields: SharedRecord['fields'] = [];
    const data: Record<string, unknown> = {};
    for (const p of d.parts) {
      if (hidden.has(p.key) || plain[p.key] === undefined) continue;
      // A contact link becomes the person's name: their record ids mean nothing elsewhere.
      const value = p.type === 'contact' ? await nameOf(String(plain[p.key])) : displayValue(p, plain[p.key]);
      if (!value) continue;
      fields.push({ key: p.key, label: p.label, value });
      data[p.key] = p.type === 'contact' ? value : plain[p.key];
    }
    out.push({ id: r._id, title: renderTitle(d, plain, hidden), fields, data, validFrom: r.validFrom, validTo: r.validTo, current: isCurrent(d, r), updatedAt: r.updatedAt });
  }
  return { domain: d.id, label: d.label, scope: g.scope, records: out };
}
