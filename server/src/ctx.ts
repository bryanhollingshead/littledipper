import type { Store } from './store/index.js';

export type Keystore = {
  /** ed25519, base64 DER */
  signing: { publicKey: string; privateKey: string };
  /** AES-256 key (base64) for Secret field values and backups. */
  masterKey: string;
};

/** Process-wide handles, set once at boot. */
export const ctx = {} as { store: Store; keys: Keystore };
