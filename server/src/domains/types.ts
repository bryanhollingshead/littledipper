import type { Sensitivity } from '../fields.js';

/** What a single part of a record can hold. Validation and display follow from this. */
export type PartType =
  | 'text'      // one line
  | 'longtext'  // paragraphs
  | 'date'      // partial ISO date: YYYY, YYYY-MM or YYYY-MM-DD (histories rarely know the day)
  | 'datetime'  // a moment and its time zone: { at: ISO 8601 with offset, tz: IANA zone } (see datetime.ts)
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
  | 'contact'   // id of a record in contacts (supervisor, landlord, doctor…)
  | 'list';     // rows of sub-parts (`of`), e.g. a receipt's line items

export type PartDef = {
  key: string;
  label: string;
  type: PartType;
  required?: boolean;
  /** Defaults to the domain's sensitivity. Only secret parts are encrypted at rest. */
  sensitivity?: Sensitivity;
  options?: [string, string][];
  hint?: string;
  /** For list parts: what each row holds. Simple types only (no list or contact). */
  of?: PartDef[];
  /** A date worth a heads-up before it passes (return by, warranty until). Shown on Home, then dropped two weeks after. */
  remind?: boolean;
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
  /** Newest-first order by this date part instead of when the record was added (receipts: purchase date). */
  sortBy?: string;
  /** Entries take linked documents (scans, photos, PDFs); new ones get this kind, e.g. 'insurance_card'. */
  documents?: string;
  builtIn: boolean;
  schemaVersion: number;
};

/** Who wrote to a record: the owner (session), an app key, an import, or Little Dipper itself. */
export type Actor = { type: 'owner' | 'app' | 'import' | 'system'; id: string };

/**
 * A record as it stood after one change (or just before, for a delete), kept so owners can see
 * how it changed and go back. Same fields as the record; secret parts stay encrypted.
 */
export type VersionDoc = Omit<RecordDoc, '_id'> & { _id: string; recordId: string; action: 'create' | 'update' | 'delete' | 'restore'; at: string; by: Actor };

export type RecordDoc = {
  _id: string;
  domain: string;
  /** Part values. Secret parts hold enc:v1:… strings. */
  data: Record<string, unknown>;
  validFrom: string | null;
  validTo: string | null;
  notes: string;
  /** Who created it. Owner, an app key, an import… */
  source: Actor;
  /** Who made the latest change: set on every create and edit, so an app's edit to the owner's record says so. */
  updatedBy: Actor;
  schemaVersion: number;
  createdAt: string;
  updatedAt: string;
};
