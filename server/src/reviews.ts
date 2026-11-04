/**
 * The Review list: changes an AI assistant proposed that wait for the owner. An assistant in "suggest" mode sends
 * every write here; in "make" mode only secret values come here. Only the owner's browser session approves.
 *
 * The proposed input is stored encrypted (it can hold an ID number). Items belong to the owner, not the key:
 * they stay approvable after the assistant is disconnected.
 */
import { ctx } from './ctx.js';
import { decrypt, encrypt, newId } from './crypto.js';
import type { ApiKeyDoc } from './auth.js';
import type { RecordInput } from './domains/records.js';
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
  /** Why it's here rather than saved: the assistant's mode, or a secret value. */
  reason: 'suggest' | 'secret';
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
    message: r.reason === 'secret'
      ? 'Saved for review: secret values always wait for the owner to check and approve them.'
      : 'Saved for review: the owner approves changes from you before they are saved.',
  };
}
