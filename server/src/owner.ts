import { ctx } from './ctx.js';
import type { Doc } from './store/index.js';

export type PasskeyRec = { credentialId: string; publicKey: string; counter: number; transports?: string[]; label: string; createdAt: string; lastUsedAt: string | null };

export type OwnerDoc = Doc & {
  displayName: string;
  email: string;
  /** True while a claim (or ownership transfer) is in progress. */
  pending?: boolean;
  passkeys: PasskeyRec[];
  passwordHash: string | null;
  totp: { enabled: boolean; secretEnc: string | null; pendingSecretEnc?: string | null };
  recoveryCodeHashes: { hash: string; usedAt: string | null }[];
  prefs: { showTechnical: boolean };
  createdAt: string;
};

export const getOwner = () => ctx.store.findOne<OwnerDoc>('owners', { pending: { $ne: true } });
export const getPendingOwner = () => ctx.store.findOne<OwnerDoc>('owners', { pending: true });

/** During setup the in-progress owner, otherwise the current one. */
export async function ownerFor(mode: 'setup' | 'session') {
  return mode === 'setup' ? getPendingOwner() : getOwner();
}
