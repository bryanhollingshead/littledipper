import type { Sensitivity } from '../fields.js';

/** What a single part of a record can hold. Validation and display follow from this. */
export type PartType =
  | 'text'      // one line
  | 'longtext'  // paragraphs
  | 'date'      // partial ISO date: YYYY, YYYY-MM or YYYY-MM-DD (histories rarely know the day)
  | 'email'
  | 'phone'
  | 'url'
  | 'country'   // ISO 3166-1 alpha-2, e.g. US
  | 'currency'  // ISO 4217, e.g. USD
  | 'money'     // { amount: number, currency: 'USD' }
  | 'number'
  | 'boolean'
  | 'enum'      // one of options
  | 'last4'     // exactly four digits. Full card/account numbers are never stored.
  | 'contact';  // id of a record in contacts (supervisor, landlord, doctor…)

export type PartDef = {
  key: string;
  label: string;
  type: PartType;
  required?: boolean;
  /** Defaults to the domain's sensitivity. Only secret parts are encrypted at rest. */
  sensitivity?: Sensitivity;
  options?: [string, string][];
  hint?: string;
};

export type DomainDef = {
  /** URL segment and grant key: /api/v1/{id}. Custom domains are prefixed x_. */
  id: string;
  label: string;
  /** Singular noun for one record, e.g. "residence". */
  noun: string;
  group: 'identity' | 'life' | 'work' | 'health' | 'money' | 'things' | 'personal' | 'custom';
  description: string;
  /** Classification for sharing: secret domains need confirmation to share and are never public. */
  sensitivity: Sensitivity;
  parts: PartDef[];
  /** Records carry validFrom/validTo; "current" = no validTo. */
  dated: boolean;
  /** Display line for one record, e.g. "{title} at {employer}". */
  title: string;
  /** Allowed on the public profile (only its non-secret, standard-or-sensitive parts the owner chooses). */
  publicable: boolean;
  builtIn: boolean;
  schemaVersion: number;
};

export type RecordDoc = {
  _id: string;
  domain: string;
  /** Part values. Secret parts hold enc:v1:… strings. */
  data: Record<string, unknown>;
  validFrom: string | null;
  validTo: string | null;
  notes: string;
  /** Who wrote it. Owner, an app key, an import… */
  source: { type: 'owner' | 'app' | 'import' | 'system'; id: string };
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
};
