/**
 * keystore://node/signing and the master data key.
 *
 * Two places it can live:
 *  - LD_KEYSTORE_KEY set (cloud installs with an ephemeral disk): stored in the
 *    database, encrypted with that key.
 *  - otherwise: a 0600 file in the data directory.
 *
 * The private key leaves this module only inside the encrypted recovery kit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { decrypt, encrypt, generateSigningKey } from './crypto.js';
import type { Keystore } from './ctx.js';
import type { Store } from './store/index.js';

const envKey = () => {
  const k = process.env.LD_KEYSTORE_KEY;
  if (!k) return null;
  // Accept any string; derive a 32-byte key from it.
  return crypto.createHash('sha256').update(k).digest().toString('base64');
};

const file = () => path.join(config.dataDir, 'keystore.json');

export function newKeystore(): Keystore {
  return { signing: generateSigningKey(), masterKey: crypto.randomBytes(32).toString('base64') };
}

export async function loadKeystore(store: Store): Promise<Keystore | null> {
  const k = envKey();
  if (k) {
    const doc = await store.get('nodes', '__keystore');
    return doc ? (JSON.parse(decrypt(k, doc.data)) as Keystore) : null;
  }
  return existsSync(file()) ? (JSON.parse(readFileSync(file(), 'utf8')) as Keystore) : null;
}

export async function saveKeystore(store: Store, ks: Keystore) {
  const k = envKey();
  if (k) {
    const data = encrypt(k, JSON.stringify(ks));
    if (await store.get('nodes', '__keystore')) await store.update('nodes', '__keystore', { data });
    else await store.insert('nodes', { _id: '__keystore', data });
    return;
  }
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file(), JSON.stringify(ks, null, 2), { mode: 0o600 });
}
