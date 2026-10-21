import { ctx } from './ctx.js';
import { newId } from './crypto.js';
import type { Doc } from './store/index.js';

export type AuditEvent = {
  actor: { type: 'owner' | 'peer' | 'public' | 'system'; id: string };
  action: string;
  resource: string;
  /** Plain-language line for the activity feed. */
  text: string;
  tone: 'peer' | 'request' | 'owner' | 'system';
  ip?: string;
  meta?: Record<string, unknown>;
};
export type AuditDoc = Doc & AuditEvent & { at: string };

/** Append-only. Every peer read, every reveal, every grant or profile change. */
export async function audit(e: AuditEvent) {
  await ctx.store.insert<AuditDoc>('audit', { _id: newId('evt'), at: new Date().toISOString(), ...e });
}

export const ownerActor = (keyId: string) => ({ type: 'owner' as const, id: keyId });
export const systemActor = { type: 'system' as const, id: 'node' };
