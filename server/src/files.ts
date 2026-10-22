/**
 * File contents: the pages of documents (scans, photos, PDFs).
 * Bytes are encrypted with the master key and kept apart from documents (Store blobs);
 * metadata lives in the `files` collection. Every file belongs to one document.
 */
import { ctx } from './ctx.js';
import { bad } from './auth.js';
import { decryptBytes, encryptBytes, newId, sha256 } from './crypto.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ORPHAN_HOURS = 24;

/** What can be uploaded, with the leading bytes each type must start with. */
const SIGNATURES: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'image/heic': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'image/heif': (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};
export const FILE_TYPES = Object.keys(SIGNATURES);

export type Source = { type: 'owner' | 'app' | 'peer' | 'system'; id: string };

export type FileDoc = {
  _id: string;
  /** Set once the document is saved. Files left without one (a failed request) are swept after a day. */
  documentId: string | null;
  name: string;
  type: string;
  size: number;
  sha256: string;
  source: Source;
  createdAt: string;
};
/** How a file appears inside a document. */
export type FileRef = { id: string; name: string; type: string; size: number };

export const fileRef = (f: FileDoc): FileRef => ({ id: f._id, name: f.name, type: f.type, size: f.size });

export async function saveFile(name: string, type: string, data: Buffer, source: Source, documentId: string | null = null): Promise<FileDoc> {
  if (!SIGNATURES[type]) throw bad('unsupported_type', 'Upload a photo (JPEG, PNG, WebP, HEIC) or a PDF');
  if (!data.length) throw bad('empty_file', 'That file is empty');
  if (data.length > MAX_FILE_BYTES) throw bad('file_too_large', 'Files can be up to 10 MB');
  if (!SIGNATURES[type](data)) throw bad('type_mismatch', 'The file’s contents don’t match its type');
  const doc: FileDoc = {
    _id: newId('fil'), documentId,
    name: cleanName(name) || 'file',
    type, size: data.length, sha256: sha256(data), source, createdAt: new Date().toISOString(),
  };
  await ctx.store.putBlob(doc._id, encryptBytes(ctx.keys.masterKey, data));
  await ctx.store.insert('files', doc);
  return doc;
}

export const cleanName = (s: string) => s.replace(/[\u0000-\u001f/\\]/g, '').trim().slice(0, 200);

export async function readFile(id: string): Promise<{ doc: FileDoc; data: Buffer } | null> {
  const doc = await ctx.store.get<FileDoc>('files', id);
  if (!doc) return null;
  const blob = await ctx.store.getBlob(id);
  return blob ? { doc, data: decryptBytes(ctx.keys.masterKey, blob) } : null;
}

export async function deleteFile(id: string) {
  await ctx.store.deleteBlob(id);
  await ctx.store.remove('files', id);
}

/** Pages whose document was never saved. */
export async function sweepOrphanFiles() {
  const cutoff = new Date(Date.now() - ORPHAN_HOURS * 3600_000).toISOString();
  for (const f of await ctx.store.find<FileDoc>('files', { documentId: null })) if (f.createdAt < cutoff) await deleteFile(f._id);
}

export function startFileSweeper() {
  sweepOrphanFiles().catch(() => {});
  setInterval(() => sweepOrphanFiles().catch(() => {}), 3600_000).unref();
}
