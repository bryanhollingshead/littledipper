import crypto from 'node:crypto';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

/** Sortable-enough unique id with a readable prefix, e.g. con_01j9x… */
export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, '0');
  return `${prefix}_${t}${crypto.randomBytes(6).toString('hex')}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// ── ed25519 node identity ────────────────────────────────────────────────

export function generateSigningKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

/** ID = "ldn_" + base32(sha256(publicKey)). Self-certifying: anyone can check it against the key. */
export function nodeIdFromPublicKey(publicKeyB64: string): string {
  const digest = crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest();
  return 'ldn_' + base32(digest).slice(0, 26);
}

/** Deterministic JSON: object keys sorted recursively. What gets signed. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(o[k])).join(',') + '}';
}

export function sign(privateKeyB64: string, payload: unknown): string {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(canonicalJson(payload)), key).toString('base64');
}

export function verify(publicKeyB64: string, payload: unknown, signatureB64: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(canonicalJson(payload)), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export function fingerprint(publicKeyB64: string): string {
  const h = sha256(Buffer.from(publicKeyB64, 'base64'));
  return `ed25519:${h.slice(0, 6)}…${h.slice(-6)}`;
}

// ── AES-256-GCM for Secret field values and backups ─────────────────────

export function encrypt(keyB64: string, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `enc:v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(keyB64: string, blob: string): string {
  const [, , ivB, tagB, ctB] = blob.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8');
}

/** Same cipher for file contents: iv (12) | tag (16) | ciphertext, as raw bytes. */
export function encryptBytes(keyB64: string, data: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function decryptBytes(keyB64: string, blob: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

export const isEncrypted = (v: unknown): v is string => typeof v === 'string' && v.startsWith('enc:v1:');

/** Passphrase-based encryption (recovery kit). scrypt → AES-256-GCM. */
export function encryptWithPassphrase(passphrase: string, plaintext: string) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { kdf: 'scrypt', N: 1 << 15, r: 8, p: 1, salt: salt.toString('base64'), data: encrypt(key.toString('base64'), plaintext) };
}

export function decryptWithPassphrase(passphrase: string, kit: { salt: string; N: number; r: number; p: number; data: string }): string {
  const key = crypto.scryptSync(passphrase, Buffer.from(kit.salt, 'base64'), 32, { N: kit.N, r: kit.r, p: kit.p, maxmem: 64 * 1024 * 1024 });
  return decrypt(key.toString('base64'), kit.data);
}

/** Recovery codes look like 7KQ2-M9XD. No 0/O/1/I to avoid misreading. */
export function recoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(8);
  const chars = [...b].map((x) => alphabet[x % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

export const normalizeRecoveryCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
