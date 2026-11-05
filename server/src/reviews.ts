/**
 * The Review list: changes an AI assistant proposed that wait for the owner. An assistant in "suggest" mode sends
 * every write here; in "make" mode only secret values and core identity come here. Only the owner's browser session approves.
 *
 * The proposed input is stored encrypted (it can hold an ID number). Items belong to the owner, not the key:
 * they stay approvable after the assistant is disconnected.
 */
import { ctx } from './ctx.js';
import { decrypt, encrypt, newId } from './crypto.js';
import type { ApiKeyDoc } from './auth.js';
import { isCurrent, plainData, type RecordInput } from './domains/records.js';
import type { DomainDef, RecordDoc } from './domains/types.js';
import type { Doc } from './store/index.js';

export type ReviewDoc = Doc & {
  keyId: string;
  /** The assistant's name when it proposed this. */
  by: string;
  domain: string;
  /** null for a new record. */
  recordId: string | null;
  action: 'create' | 'update';
  /** RecordInput, encrypted. */
  input: string;
  /** Why it's here rather than saved: the assistant's mode, a secret value, or core identity. */
  reason: 'suggest' | 'secret' | 'identity';
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  decidedAt: string | null;
  /** The record it created or changed, once approved. */
  resultId?: string;
};

export async function propose(key: ApiKeyDoc, domain: string, recordId: string | null, input: RecordInput, reason: ReviewDoc['reason']): Promise<ReviewDoc> {
  const doc: ReviewDoc = {
    _id: newId('rev'), keyId: key._id, by: key.name, domain, recordId, action: recordId ? 'update' : 'create',
    input: encrypt(ctx.keys.masterKey, JSON.stringify(input)), reason, status: 'pending', createdAt: new Date().toISOString(), decidedAt: null,
  };
  await ctx.store.insert('reviews', doc);
  return doc;
}

export const reviewInput = (r: ReviewDoc) => JSON.parse(decrypt(ctx.keys.masterKey, r.input)) as RecordInput;

export const pendingCount = async () => (await ctx.store.find<ReviewDoc>('reviews', { status: 'pending' })).length;

/** What an assistant is told when its change waits for the owner. */
export function pendingReply(r: ReviewDoc) {
  return {
    status: 'pending_review', reviewId: r._id, domain: r.domain, recordId: r.recordId, action: r.action,
    message: {
      secret: 'Saved for review: secret values always wait for the owner to check and approve them.',
      identity: 'Saved for review: changes to core identity (legal names, citizenship, IDs, current address, email and phone) always wait for the owner to approve them.',
      suggest: 'Saved for review: the owner approves changes from you before they are saved.',
    }[r.reason],
  };
}

/** Names that are legal identity, as opposed to nicknames and aliases. */
const IDENTITY_NAMES = new Set(['legal', 'birth', 'previous_legal']);

/**
 * Core identity: what forms, sharing and identity verification check against. An assistant's change to it always
 * waits for the owner, even in make mode. For residences, that's any change touching the current address.
 */
export function isIdentityChange(d: DomainDef, input: RecordInput, existing: RecordDoc | null) {
  if (['ids', 'citizenship', 'contact_methods'].includes(d.id)) return true;
  if (d.id === 'names') return [input.data?.kind, existing && plainData(existing).kind].some((k) => IDENTITY_NAMES.has(String(k)));
  if (d.id === 'residences') {
    const validTo = input.validTo !== undefined ? input.validTo : existing?.validTo ?? null;
    return (!!existing && isCurrent(d, existing)) || isCurrent(d, { validTo } as RecordDoc);
  }
  return false;
}
