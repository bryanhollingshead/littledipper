/** Records engine: validation, part-level encryption, output shapes and derived profile fields. */
import { ctx } from '../ctx.js';
import { decrypt, encrypt, isEncrypted, newId } from '../crypto.js';
import { bad } from '../auth.js';
import { mask, storeValue, type FieldDoc, type Sensitivity } from '../fields.js';
import { BUILT_IN_DOMAINS, RESERVED } from './catalog.js';
import type { DomainDef, PartDef, PartType, RecordDoc } from './types.js';

export type { DomainDef, PartDef, RecordDoc };

const RANK: Record<Sensitivity, number> = { standard: 0, sensitive: 1, secret: 2 };
export const maxSens = (a: Sensitivity, b: Sensitivity) => (RANK[a] >= RANK[b] ? a : b);
export const partSens = (d: DomainDef, p: PartDef): Sensitivity => p.sensitivity ?? d.sensitivity;

// ── registry ───────────────────────────────────────────────────────────

export async function listDomains(): Promise<DomainDef[]> {
  const custom = await ctx.store.find<DomainDef & { _id: string }>('domainDefs', {}, { sort: { label: 1 } });
  return [...BUILT_IN_DOMAINS, ...custom.map(({ _id, ...d }) => d as DomainDef)];
}

export async function getDomain(id: string): Promise<DomainDef | null> {
  return BUILT_IN_DOMAINS.find((d) => d.id === id) ?? (await ctx.store.findOne<DomainDef & { _id: string }>('domainDefs', { id })) ?? null;
}

const PART_TYPES: PartType[] = ['text', 'longtext', 'date', 'email', 'phone', 'url', 'country', 'currency', 'money', 'number', 'boolean', 'enum', 'last4', 'contact'];

/** Validate an owner-defined domain. Ids are x_ + slug so they never collide with built-ins or routes. */
export function checkCustomDomain(input: Partial<DomainDef>): DomainDef {
  const label = String(input.label || '').trim();
  if (!label) throw bad('label_required', 'Give the category a name');
  const slug = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  const id = `x_${slug || 'custom'}`;
  if (RESERVED.has(id)) throw bad('reserved');
  const parts = (input.parts || []).map((p, i) => {
    const key = String(p.key || p.label || `part${i}`).replace(/[^a-zA-Z0-9]/g, '').slice(0, 30) || `part${i}`;
    if (!PART_TYPES.includes(p.type)) throw bad('bad_part_type', `Unknown type for ${p.label}`);
    if (p.type === 'enum' && !p.options?.length) throw bad('options_required', `${p.label} needs options`);
    return { key, label: String(p.label || key), type: p.type, required: !!p.required, sensitivity: p.sensitivity, options: p.options, hint: p.hint } as PartDef;
  });
  if (!parts.length) throw bad('parts_required', 'Add at least one detail to the category');
  if (new Set(parts.map((p) => p.key)).size !== parts.length) throw bad('duplicate_parts', 'Two details have the same name');
  const sensitivity = (['standard', 'sensitive', 'secret'] as Sensitivity[]).includes(input.sensitivity as Sensitivity) ? (input.sensitivity as Sensitivity) : 'sensitive';
  return {
    id, label, noun: String(input.noun || label.toLowerCase()), group: 'custom', description: String(input.description || ''),
    sensitivity, parts, dated: !!input.dated, title: input.title || `{${parts[0].key}}`,
    publicable: !!input.publicable && sensitivity !== 'secret',
    builtIn: false, schemaVersion: 1,
  };
}

// ── validation ─────────────────────────────────────────────────────────

const DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const isPartialDate = (v: unknown) => typeof v === 'string' && DATE.test(v);

async function checkPart(p: PartDef, v: unknown): Promise<unknown> {
  const fail = (why: string) => { throw bad('invalid_value', `${p.label}: ${why}`); };
  switch (p.type) {
    case 'text': case 'longtext': {
      const s = String(v).trim();
      if (s.length > (p.type === 'text' ? 500 : 10000)) fail('too long');
      return s;
    }
    case 'date': return isPartialDate(v) ? v : fail('use YYYY, YYYY-MM or YYYY-MM-DD');
    case 'email': return EMAIL.test(String(v).trim()) ? String(v).trim() : fail('not an email address');
    case 'phone': return /^[+\d][\d\s().\-x]{3,30}$/.test(String(v).trim()) ? String(v).trim() : fail('not a phone number');
    case 'url': {
      const s = String(v).trim();
      try { const u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`); return u.toString(); } catch { return fail('not a web address'); }
    }
    case 'country': { const s = String(v).toUpperCase(); return /^[A-Z]{2}$/.test(s) ? s : fail('use a two-letter country code, e.g. US'); }
    case 'currency': { const s = String(v).toUpperCase(); return /^[A-Z]{3}$/.test(s) ? s : fail('use a three-letter currency code, e.g. USD'); }
    case 'money': {
      const m = v as { amount?: unknown; currency?: unknown };
      const amount = Number(m?.amount);
      const currency = String(m?.currency || 'USD').toUpperCase();
      if (!Number.isFinite(amount)) fail('amount must be a number');
      if (!/^[A-Z]{3}$/.test(currency)) fail('bad currency');
      return { amount, currency };
    }
    case 'number': { const n = Number(v); return Number.isFinite(n) ? n : fail('must be a number'); }
    case 'boolean': return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : fail('must be true or false');
    case 'enum': return p.options!.some(([k]) => k === v) ? v : fail(`must be one of ${p.options!.map(([k]) => k).join(', ')}`);
    case 'last4': return /^\d{4}$/.test(String(v)) ? String(v) : fail('only the last four digits, never the full number');
    case 'contact': return (await ctx.store.get('contacts', String(v))) ? String(v) : fail('no such contact');
  }
}

const empty = (v: unknown) => v === undefined || v === null || v === '';

export type RecordInput = { data?: Record<string, unknown>; validFrom?: string | null; validTo?: string | null; notes?: string };

/**
 * Build the stored form of a record from input (create) or input merged onto an existing record (patch).
 * In a patch, a part set to null is removed; parts not mentioned are kept as stored (still encrypted).
 */
export async function buildRecord(d: DomainDef, input: RecordInput, existing: RecordDoc | null, source: RecordDoc['source']): Promise<RecordDoc> {
  const inData = (input.data ?? {}) as Record<string, unknown>;
  const unknownKeys = Object.keys(inData).filter((k) => !d.parts.some((p) => p.key === k));
  if (unknownKeys.length) throw bad('unknown_parts', `${d.label} has no ${unknownKeys.join(', ')}`);
  const data: Record<string, unknown> = existing ? { ...existing.data } : {};
  for (const p of d.parts) {
    if (!(p.key in inData)) continue;
    const v = inData[p.key];
    if (empty(v)) { delete data[p.key]; continue; }
    const clean = await checkPart(p, v);
    data[p.key] = partSens(d, p) === 'secret' ? encrypt(ctx.keys.masterKey, JSON.stringify(clean)) : clean;
  }
  const missing = d.parts.filter((p) => p.required && empty(data[p.key]));
  if (missing.length) throw bad('required', `${d.label} needs ${missing.map((p) => p.label.toLowerCase()).join(', ')}`);

  let validFrom = existing?.validFrom ?? null, validTo = existing?.validTo ?? null;
  if (d.dated) {
    if (input.validFrom !== undefined) validFrom = empty(input.validFrom) ? null : isPartialDate(input.validFrom) ? input.validFrom! : (() => { throw bad('invalid_value', 'From: use YYYY, YYYY-MM or YYYY-MM-DD'); })();
    if (input.validTo !== undefined) validTo = empty(input.validTo) ? null : isPartialDate(input.validTo) ? input.validTo! : (() => { throw bad('invalid_value', 'To: use YYYY, YYYY-MM or YYYY-MM-DD'); })();
    if (validFrom && validTo && validTo < validFrom) throw bad('invalid_value', '“To” is before “From”');
  }
  const t = new Date().toISOString();
  return {
    _id: existing?._id ?? newId('rec'), domain: d.id, data, validFrom, validTo,
    notes: input.notes !== undefined ? String(input.notes).slice(0, 10000) : existing?.notes ?? '',
    source: existing?.source ?? source, schemaVersion: d.schemaVersion, createdAt: existing?.createdAt ?? t, updatedAt: t,
  };
}

// ── reading ────────────────────────────────────────────────────────────

/** Part values with secrets decrypted. */
export function plainData(rec: RecordDoc): Record<string, unknown> {
  return Object.fromEntries(Object.entries(rec.data).map(([k, v]) => [k, isEncrypted(v) ? JSON.parse(decrypt(ctx.keys.masterKey, v)) : v]));
}

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const countryName = (code: string) => { try { return regionNames.of(code) || code; } catch { return code; } };

export function displayValue(p: PartDef, v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  switch (p.type) {
    case 'enum': return p.options?.find(([k]) => k === v)?.[1] ?? String(v);
    case 'country': return countryName(String(v));
    case 'money': { const m = v as { amount: number; currency: string }; try { return new Intl.NumberFormat('en', { style: 'currency', currency: m.currency, maximumFractionDigits: 0 }).format(m.amount); } catch { return `${m.amount} ${m.currency}`; } }
    case 'boolean': return v ? 'Yes' : 'No';
    default: return String(v);
  }
}

export function renderTitle(d: DomainDef, values: Record<string, unknown>, hidden: Set<string> = new Set()): string {
  const out = d.title.replace(/\{(\w+)\}/g, (_, k) => {
    if (hidden.has(k)) return '••••';
    const p = d.parts.find((x) => x.key === k);
    return p ? displayValue(p, values[k]) : '';
  });
  return out.replace(/\(\s*\)/g, '').replace(/\s+(at|·|:)\s*$/g, '').replace(/^\s*(·|:|at)\s+/g, '').replace(/\s{2,}/g, ' ').replace(/\s+·\s+·\s+/g, ' · ').trim() || d.noun;
}

export const isCurrent = (d: DomainDef, r: RecordDoc) => !d.dated || !r.validTo || r.validTo >= new Date().toISOString().slice(0, r.validTo.length);

/** API shape. Secret parts are masked unless revealed; `masked` lists which. */
export function recordOut(d: DomainDef, r: RecordDoc, opts: { reveal?: boolean } = {}) {
  const plain = plainData(r);
  const data: Record<string, unknown> = {};
  const masked: string[] = [];
  for (const p of d.parts) {
    if (!(p.key in plain)) continue;
    if (partSens(d, p) === 'secret' && !opts.reveal) {
      masked.push(p.key);
      data[p.key] = p.type === 'money' ? null : mask(String(plain[p.key]));
    } else data[p.key] = plain[p.key];
  }
  return {
    id: r._id, domain: d.id, title: renderTitle(d, plain, opts.reveal ? undefined : new Set(masked)),
    data, masked, validFrom: r.validFrom, validTo: r.validTo, current: isCurrent(d, r),
    notes: r.notes, source: r.source, schemaVersion: r.schemaVersion, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

/** Newest first; current records ahead of ended ones. */
export function sortRecords(d: DomainDef, recs: RecordDoc[]) {
  return recs.sort((a, b) => {
    if (d.dated) {
      const ca = isCurrent(d, a) ? 1 : 0, cb = isCurrent(d, b) ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return String(b.validFrom ?? '').localeCompare(String(a.validFrom ?? '')) || b.createdAt.localeCompare(a.createdAt);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export async function recordsOf(domainId: string) {
  return ctx.store.find<RecordDoc & { [k: string]: unknown }>('records', { domain: domainId }) as Promise<RecordDoc[]>;
}

// ── derived profile fields ─────────────────────────────────────────────
// A few core profile fields mirror domain records so there is one source of truth:
// edit your residence and "Current address" follows.

export const DERIVED: Record<string, { domain: string; compute: (recs: RecordDoc[]) => string }> = {
  address: { domain: 'residences', compute: (r) => { const c = currentOf('residences', r); if (!c) return ''; const v = plainData(c); return [v.street1, v.street2, v.city, [v.region, v.postalCode].filter(Boolean).join(' '), v.country && v.country !== 'US' ? countryName(String(v.country)) : ''].filter(Boolean).join(', '); } },
  country_res: { domain: 'residences', compute: (r) => { const c = currentOf('residences', r); return c?.data.country ? countryName(String(plainData(c).country)) : ''; } },
  // City only, so the owner can go public with where they live without the street: "Portland, OR" or "Lyon, France".
  city: { domain: 'residences', compute: (r) => { const c = currentOf('residences', r); if (!c) return ''; const v = plainData(c); return [v.city, v.region, v.country && v.country !== 'US' ? countryName(String(v.country)) : ''].filter(Boolean).join(', '); } },
  email: { domain: 'contact_methods', compute: (r) => primaryOf(r, 'email') },
  phone: { domain: 'contact_methods', compute: (r) => primaryOf(r, 'phone') },
};

function currentOf(domain: string, recs: RecordDoc[]) {
  const d = BUILT_IN_DOMAINS.find((x) => x.id === domain)!;
  return sortRecords(d, recs.filter((r) => isCurrent(d, r)))[0];
}
function primaryOf(recs: RecordDoc[], kind: string) {
  const mine = recs.filter((r) => r.data.kind === kind);
  const pick = mine.find((r) => r.data.primary === true) ?? mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  return pick ? String(pick.data.value) : '';
}

/** Recompute derived fields fed by this domain. Cheap: a handful of records. */
export async function syncDerived(domainId: string) {
  const keys = Object.entries(DERIVED).filter(([, v]) => v.domain === domainId).map(([k]) => k);
  if (!keys.length) return;
  const recs = await recordsOf(domainId);
  for (const key of keys) {
    const f = await ctx.store.findOne<FieldDoc>('fields', { key });
    // Only fields that were switched over (see migrate.ts); a plain field is the owner's to edit.
    if (!f || f.derivedFrom !== domainId) continue;
    const value = DERIVED[key].compute(recs);
    await ctx.store.update('fields', f._id, { value: storeValue(value, f.sensitivity), updatedAt: new Date().toISOString() });
  }
}

/** Only one primary per kind of contact method. */
export async function demoteOtherPrimaries(rec: RecordDoc) {
  if (rec.domain !== 'contact_methods' || rec.data.primary !== true) return;
  for (const r of await recordsOf('contact_methods')) {
    if (r._id !== rec._id && r.data.kind === rec.data.kind && r.data.primary === true) await ctx.store.update('records', r._id, { data: { ...r.data, primary: false } });
  }
}
