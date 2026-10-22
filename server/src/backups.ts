import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { ctx } from './ctx.js';
import { decrypt, encrypt, newId } from './crypto.js';
import { audit, systemActor } from './audit.js';
import { getNode } from './node.js';
import type { Doc } from './store/index.js';

export type BackupDoc = Doc & {
  at: string; size: number; documents: number; file: string; reason: 'scheduled' | 'manual' | 'pre-update' | 'pre-restore';
  /** File contents this backup needs, kept once each in backups/blobs (already encrypted). */
  blobs?: string[];
};

const KEEP_DAYS = 30;
const dir = () => path.join(config.dataDir, 'backups');
const blobDir = () => path.join(dir(), 'blobs');
const blobFile = (id: string) => path.join(blobDir(), id.replace(/[^a-z0-9_]/g, ''));
const SKIP = new Set(['backups', 'challenges']);

export async function createBackup(reason: BackupDoc['reason']): Promise<BackupDoc> {
  const dump = await ctx.store.dump();
  const data = Object.fromEntries(Object.entries(dump).filter(([c]) => !SKIP.has(c)));
  const documents = Object.values(data).reduce((n, docs) => n + docs.length, 0);
  const id = newId('bak');
  mkdirSync(dir(), { recursive: true });
  const file = path.join(dir(), `${id}.ldbak`);
  // Encrypted with the node's master key: backups stay safe wherever they're copied.
  writeFileSync(file, encrypt(ctx.keys.masterKey, JSON.stringify({ format: 'ldbak', v: 1, data })), { mode: 0o600 });
  // Document pages: a file's contents never change, so each is copied once and shared by every backup that needs it.
  const blobs: string[] = [];
  mkdirSync(blobDir(), { recursive: true });
  for (const f of data.files ?? []) {
    if (!existsSync(blobFile(f._id))) {
      const b = await ctx.store.getBlob(f._id);
      if (!b) continue;
      writeFileSync(blobFile(f._id), b, { mode: 0o600 });
    }
    blobs.push(f._id);
  }
  const doc: BackupDoc = { _id: id, at: new Date().toISOString(), size: statSync(file).size, documents, file: path.basename(file), reason, blobs };
  await ctx.store.insert('backups', doc);
  const n = await getNode();
  await ctx.store.update('nodes', n._id, { lastBackupAt: doc.at });
  await prune();
  return doc;
}

async function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  for (const b of await ctx.store.find<BackupDoc>('backups')) {
    if (new Date(b.at).getTime() < cutoff) {
      const f = path.join(dir(), b.file);
      if (existsSync(f)) unlinkSync(f);
      await ctx.store.remove('backups', b._id);
    }
  }
  const kept = new Set((await ctx.store.find<BackupDoc>('backups')).flatMap((b) => b.blobs ?? []));
  if (existsSync(blobDir())) for (const f of readdirSync(blobDir())) if (!kept.has(f)) unlinkSync(path.join(blobDir(), f));
}

export async function listBackups() {
  const docs = await ctx.store.find<BackupDoc>('backups', {}, { sort: { at: -1 } });
  return docs.map((b) => ({ ...b, available: existsSync(path.join(dir(), b.file)) }));
}

export async function restoreBackup(id: string) {
  const b = await ctx.store.get<BackupDoc>('backups', id);
  if (!b) throw new Error('backup not found');
  const raw = readFileSync(path.join(dir(), b.file), 'utf8');
  const { data } = JSON.parse(decrypt(ctx.keys.masterKey, raw)) as { data: Record<string, Doc[]> };
  await createBackup('pre-restore');
  const keep = await ctx.store.dump();
  await ctx.store.restore({ ...data, backups: keep.backups, challenges: [] });
  // Bring back the contents of any page deleted since this backup.
  for (const f of data.files ?? []) {
    if (!(await ctx.store.getBlob(f._id)) && existsSync(blobFile(f._id))) await ctx.store.putBlob(f._id, readFileSync(blobFile(f._id)));
  }
}

/** Nightly at 03:00 server time. */
export function scheduleBackups(log: (m: string) => void) {
  const tick = async () => {
    try {
      const n = await getNode();
      if (!n.claimed) return;
      const d = new Date();
      const last = n.lastBackupAt ? new Date(n.lastBackupAt) : null;
      const doneToday = last && last.toDateString() === d.toDateString() && last.getHours() >= 3;
      if (d.getHours() === 3 && !doneToday) {
        const b = await createBackup('scheduled');
        await audit({ actor: systemActor, action: 'backup.create', resource: `backups/${b._id}`, text: `Nightly backup completed · ${b.documents} documents`, tone: 'system' });
        log(`Nightly backup ${b._id} (${b.documents} documents)`);
      }
    } catch (e) {
      log(`Backup failed: ${(e as Error).message}`);
    }
  };
  return setInterval(tick, 10 * 60_000);
}
