/**
 * Data migrations, run at boot and after claim. Idempotent.
 *
 * v2 (domains): Current address / Country of residence now mirror the current Residence,
 * Email / Mobile phone mirror the primary Contact method. Existing values become records.
 * A value that can't be parsed safely stays a plain field rather than being lost.
 */
import { ctx } from './ctx.js';
import { plainValue, seedFields, type FieldDoc } from './fields.js';
import { getNode } from './node.js';
import { BUILT_IN_DOMAINS } from './domains/catalog.js';
import { buildRecord, countryName, recordsOf, syncDerived } from './domains/records.js';
import type { RecordDoc } from './domains/types.js';

const SYSTEM = { type: 'system' as const, id: 'migration-v2' };
const domain = (id: string) => BUILT_IN_DOMAINS.find((d) => d.id === id)!;

/** "United States" → "US", using the same names we display. */
function countryCode(name: string): string | null {
  const n = name.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(n)) return n.toUpperCase();
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    if (countryName(code).toLowerCase() === n) return code;
  }
  return null;
}

/** "2214 SE Ankeny St, Portland, OR 97214" → parts. Null when it doesn't look like street, city[, region postal]. */
function parseAddress(s: string, country: string | null) {
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2 || !country) return null;
  const [street1, city, rest = ''] = parts;
  const m = rest.match(/^([A-Za-z .]+?)\s*([A-Z0-9][A-Z0-9 -]{2,9})?$/);
  return { street1, city, region: m?.[1]?.trim() || undefined, postalCode: m?.[2]?.trim() || undefined, country };
}

async function field(key: string) {
  return ctx.store.findOne<FieldDoc>('fields', { key });
}

async function addRecord(domainId: string, data: Record<string, unknown>) {
  const rec = await buildRecord(domain(domainId), { data }, null, SYSTEM);
  await ctx.store.insert('records', rec);
}

/** Run a migration step at most once per node. */
async function once(id: string, step: () => Promise<void>) {
  const n = await getNode();
  if (n.migrations?.includes(id)) return;
  await step();
  await ctx.store.update('nodes', n._id, { migrations: [...(n.migrations ?? []), id] });
}

export async function runMigrations(log: (m: string) => void = () => {}) {
  if (!(await ctx.store.count('fields'))) return; // not claimed yet

  // Residences ← Current address + Country of residence
  const addr = await field('address'), cres = await field('country_res');
  if (addr && !addr.derivedFrom) {
    const text = plainValue(addr);
    const code = cres ? countryCode(plainValue(cres)) : null;
    let ok = !text;
    if (text && !(await recordsOf('residences')).length) {
      const parsed = parseAddress(text, code);
      if (parsed) {
        try { await addRecord('residences', parsed); ok = true; log('Moved current address into Residences'); } catch { /* keep as a plain field */ }
      }
    }
    if (ok) await ctx.store.update('fields', addr._id, { derivedFrom: 'residences' });
  }
  // Country of residence follows only once a residence exists (or it was empty), so a lone value isn't wiped.
  if (cres && !cres.derivedFrom && ((await recordsOf('residences')).length || !plainValue(cres))) {
    await ctx.store.update('fields', cres._id, { derivedFrom: 'residences' });
  }
  // Current city ← current Residence. Added once, so an owner who deletes the field doesn't get it back on the next boot.
  await once('city-field', async () => {
    await seedFields({});
    const city = await field('city');
    // Leave alone an owner's own "city" field that already holds a value.
    if (city && !city.derivedFrom && !plainValue(city)) await ctx.store.update('fields', city._id, { derivedFrom: 'residences' });
  });
  await syncDerived('residences');

  // Contact methods ← Email + Mobile phone
  for (const [key, kind] of [['email', 'email'], ['phone', 'phone']] as const) {
    const f = await field(key);
    if (!f || f.derivedFrom) continue;
    const text = plainValue(f);
    let ok = !text;
    if (text) {
      const exists = (await recordsOf('contact_methods')).some((r) => r.data.kind === kind && r.data.value === text);
      try {
        if (!exists) await addRecord('contact_methods', { kind, label: key === 'phone' ? 'Mobile' : 'Personal', value: text, primary: true });
        ok = true;
      } catch { /* odd format: keep as a plain field */ }
    }
    if (ok) await ctx.store.update('fields', f._id, { derivedFrom: 'contact_methods' });
  }
  await syncDerived('contact_methods');

  // Per-edit provenance: a record from before it existed was last changed by whoever created it.
  await once('record-updated-by', async () => {
    for (const r of await ctx.store.find<RecordDoc>('records', { updatedBy: { $exists: false } })) await ctx.store.update('records', r._id, { updatedBy: r.source });
  });
}
