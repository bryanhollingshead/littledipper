import { ctx } from './ctx.js';
import { decrypt, encrypt, isEncrypted, newId } from './crypto.js';
import type { Doc } from './store/index.js';

export type Sensitivity = 'standard' | 'sensitive' | 'secret';
export const SENSITIVITIES: Sensitivity[] = ['standard', 'sensitive', 'secret'];
export const SECTIONS = ['identity', 'contact', 'residence', 'gov', 'custom'] as const;

export type FieldDoc = Doc & {
  key: string;
  label: string;
  section: (typeof SECTIONS)[number];
  type: 'text' | 'date' | 'address' | 'document';
  /** Stored encrypted (enc:v1:…) when sensitivity = secret. */
  value: string;
  sensitivity: Sensitivity;
  order: number;
  /** Set when the value mirrors a domain (e.g. residences): edit it there. */
  derivedFrom?: string;
  updatedAt: string;
};

/** Default seed. Government IDs are not seeded or prompted; owners may add them later as Secret fields. */
export const SEED: [string, string, FieldDoc['section'], Sensitivity, FieldDoc['type']][] = [
  ['legal_name', 'Legal name', 'identity', 'standard', 'text'],
  ['preferred_name', 'Preferred name', 'identity', 'standard', 'text'],
  ['dob', 'Date of birth', 'identity', 'sensitive', 'date'],
  ['country_birth', 'Country of birth', 'identity', 'sensitive', 'text'],
  ['citizenship', 'Citizenship', 'identity', 'sensitive', 'text'],
  ['email', 'Email', 'contact', 'standard', 'text'],
  ['phone', 'Mobile phone', 'contact', 'standard', 'text'],
  ['address', 'Current address', 'residence', 'sensitive', 'address'],
  ['country_res', 'Country of residence', 'residence', 'standard', 'text'],
  ['city', 'Current city', 'residence', 'standard', 'text'],
];

export async function seedFields(initial: Record<string, string>) {
  const now = new Date().toISOString();
  for (const [i, [key, label, section, sensitivity, type]] of SEED.entries()) {
    if (await ctx.store.findOne('fields', { key })) continue;
    await ctx.store.insert<FieldDoc>('fields', { _id: newId('fld'), key, label, section, type, value: initial[key] || '', sensitivity, order: i, updatedAt: now });
  }
}

export const plainValue = (f: FieldDoc) => (isEncrypted(f.value) ? decrypt(ctx.keys.masterKey, f.value) : f.value);
export const storeValue = (value: string, s: Sensitivity) => (s === 'secret' && value ? encrypt(ctx.keys.masterKey, value) : value);

export function mask(v: string) {
  if (!v) return '';
  const tail = v.replace(/\s/g, '').slice(-4);
  return '•••• ' + (v.length > 6 ? tail : '');
}

export async function allFields(): Promise<FieldDoc[]> {
  return ctx.store.find<FieldDoc>('fields', {}, { sort: { order: 1 } });
}

/** API shape. Secret values are masked unless revealed. */
export function fieldOut(f: FieldDoc, opts: { reveal?: boolean } = {}) {
  const secret = f.sensitivity === 'secret';
  const plain = plainValue(f);
  return {
    key: f.key, label: f.label, section: f.section, type: f.type, sensitivity: f.sensitivity,
    value: secret && !opts.reveal ? mask(plain) : plain,
    masked: secret && !opts.reveal,
    hasValue: !!plain,
    derivedFrom: f.derivedFrom || null,
    updatedAt: f.updatedAt,
  };
}

export const slugKey = (label: string) =>
  label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'field';
