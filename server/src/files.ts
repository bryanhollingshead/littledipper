/**
 * Attached files: receipt photos and PDFs today, the documents module later.
 * Each file belongs to one domain (its scopes guard it) and, once saved on a record, to that record.
 * Contents are encrypted with the master key; metadata lives in the `files` collection.
 */
import { ctx } from './ctx.js';
import { bad } from './auth.js';
import { decryptBytes, encryptBytes, newId, sha256 } from './crypto.js';
import type { DomainDef, RecordDoc } from './domains/types.js';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PER_PART = 20;
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

export type FileDoc = {
  _id: string;
  domain: string;
  /** Set when a record references it. Unattached uploads are swept after a day. */
  recordId: string | null;
  name: string;
  type: string;
  size: number;
  sha256: string;
  source: RecordDoc['source'];
  createdAt: string;
};
/** How a file appears inside a record's data. */
export type FileRef = { id: string; name: string; type: string; size: number };

export const fileRef = (f: FileDoc): FileRef => ({ id: f._id, name: f.name, type: f.type, size: f.size });
export const fileOut = (f: FileDoc) => ({ ...fileRef(f), domain: f.domain, recordId: f.recordId, sha256: f.sha256, createdAt: f.createdAt, url: `/api/v1/files/${f._id}` });

export async function saveFile(domain: string, name: string, type: string, data: Buffer, source: FileDoc['source']): Promise<FileDoc> {
  if (!SIGNATURES[type]) throw bad('unsupported_type', 'Upload a photo (JPEG, PNG, WebP, HEIC) or a PDF');
  if (!data.length) throw bad('empty_file', 'That file is empty');
  if (data.length > MAX_FILE_BYTES) throw bad('file_too_large', 'Files can be up to 10 MB');
  if (!SIGNATURES[type](data)) throw bad('type_mismatch', 'The file’s contents don’t match its type');
  const doc: FileDoc = {
    _id: newId('fil'), domain, recordId: null,
    name: name.replace(/[\u0000-\u001f/\\]/g, '').trim().slice(0, 200) || 'file',
    type, size: data.length, sha256: sha256(data), source, createdAt: new Date().toISOString(),
  };
  await ctx.store.putBlob(doc._id, encryptBytes(ctx.keys.masterKey, data));
  await ctx.store.insert('files', doc);
  return doc;
}

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

/** Validate a files part: ids (or refs with ids) of files in this domain, not attached to another record. */
export async function checkFiles(label: string, v: unknown, domain: string, recordId: string | null): Promise<FileRef[]> {
  const fail = (why: string) => { throw bad('invalid_value', `${label}: ${why}`); };
  if (!Array.isArray(v)) fail('expected a list of file ids');
  const ids = [...new Set((v as unknown[]).map((x) => (typeof x === 'string' ? x : String((x as { id?: unknown })?.id ?? ''))))];
  if (ids.length > MAX_PER_PART) fail(`up to ${MAX_PER_PART} files`);
  const out: FileRef[] = [];
  for (const id of ids) {
    const f = await ctx.store.get<FileDoc>('files', id);
    if (!f || f.domain !== domain) fail(`no such file ${id}`);
    if (f!.recordId && f!.recordId !== recordId) fail(`${f!.name} belongs to another entry`);
    out.push(fileRef(f!));
  }
  return out;
}

const refsOf = (d: DomainDef, rec: RecordDoc) => d.parts.filter((p) => p.type === 'files').flatMap((p) => (Array.isArray(rec.data[p.key]) ? (rec.data[p.key] as FileRef[]).map((r) => r.id) : []));

/** After a record is saved: claim the files it references, delete the ones it no longer does. */
export async function syncRecordFiles(d: DomainDef, rec: RecordDoc) {
  if (!d.parts.some((p) => p.type === 'files')) return;
  const keep = new Set(refsOf(d, rec));
  for (const id of keep) await ctx.store.update('files', id, { recordId: rec._id });
  for (const f of await ctx.store.find<FileDoc>('files', { recordId: rec._id })) if (!keep.has(f._id)) await deleteFile(f._id);
}

export async function removeRecordFiles(recordId: string) {
  for (const f of await ctx.store.find<FileDoc>('files', { recordId })) await deleteFile(f._id);
}

/** Uploads that never made it onto a record (a closed editor, a failed save). */
export async function sweepOrphanFiles() {
  const cutoff = new Date(Date.now() - ORPHAN_HOURS * 3600_000).toISOString();
  for (const f of await ctx.store.find<FileDoc>('files', { recordId: null })) if (f.createdAt < cutoff) await deleteFile(f._id);
}

export function startFileSweeper() {
  sweepOrphanFiles().catch(() => {});
  setInterval(() => sweepOrphanFiles().catch(() => {}), 3600_000).unref();
}
