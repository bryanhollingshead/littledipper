/**
 * Keeping copies of the node's backups on the owner's own device. Any browser can download one;
 * in browsers that allow it (Chrome, Edge) the owner picks a folder once and the app saves each
 * new backup there whenever it's open. A folder synced by iCloud Drive, Dropbox or OneDrive takes
 * them off the computer too. The files are encrypted: useless without the recovery kit.
 */
import { useEffect, useState } from 'react';
import { get, post, saveFile } from './api';

type Perm = 'granted' | 'denied' | 'prompt';
/** The File System Access parts we use, which TypeScript's DOM types don't all describe yet. */
type Folder = FileSystemDirectoryHandle & {
  queryPermission(o: { mode: 'readwrite' }): Promise<Perm>;
  requestPermission(o: { mode: 'readwrite' }): Promise<Perm>;
  values(): AsyncIterable<FileSystemHandle>;
};
type BackupRow = { _id: string; at: string; available: boolean };

/** How many backup files to keep in the chosen folder; older ones the app saved are removed. */
const KEEP = 14;
const NAME = /^little-dipper-\d{4}-\d{2}-\d{2}-\d{4}\.ldbackup$/;
/** The same name the server gives the file, so a backup already in the folder isn't fetched again. */
const fileName = (at: string) => `little-dipper-${at.slice(0, 16).replace('T', '-').replace(':', '')}.ldbackup`;

export const canUseFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;

// The folder is this device's choice, not the node's: it lives in this browser's IndexedDB.
function store<T>(fn: (s: IDBObjectStore) => IDBRequest<T>, mode: IDBTransactionMode = 'readonly'): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('little-dipper', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('device');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = fn(open.result.transaction('device', mode).objectStore('device'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}
const getFolder = () => store<Folder | undefined>((s) => s.get('backupFolder')).catch(() => undefined);
const keepFolder = (f: Folder | null) => store<unknown>((s) => (f ? s.put(f, 'backupFolder') : s.delete('backupFolder')) as IDBRequest<unknown>, 'readwrite');

async function latest(): Promise<BackupRow | null> {
  return (await get<{ items: BackupRow[] }>('/api/v1/node/backups')).items.find((b) => b.available) ?? null;
}

async function fetchFile(id: string, via: 'download' | 'folder') {
  const r = await fetch(`/api/v1/node/backups/${id}/download?via=${via}`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('Couldn’t fetch the backup');
  return r.text();
}

/** Take a fresh backup and save it to this device as a download. */
export async function downloadFresh() {
  await post('/api/v1/node/backups');
  const b = await latest();
  if (!b) throw new Error('No backup to save yet');
  saveFile(fileName(b.at), await fetchFile(b._id, 'download'));
}

/** Download one particular backup. */
export async function downloadBackup(b: BackupRow) {
  saveFile(fileName(b.at), await fetchFile(b._id, 'download'));
}

/** Save the newest backup into the chosen folder if it isn't there yet, then trim old ones. */
async function saveToFolder(f: Folder, fresh = false): Promise<'saved' | 'up-to-date' | 'needs-permission'> {
  if ((await f.queryPermission({ mode: 'readwrite' })) !== 'granted') return 'needs-permission';
  if (fresh) await post('/api/v1/node/backups');
  const b = await latest();
  if (!b) return 'up-to-date';
  const name = fileName(b.at);
  try { await f.getFileHandle(name); return 'up-to-date'; } catch { /* not there yet */ }
  const text = await fetchFile(b._id, 'folder');
  const w = await (await f.getFileHandle(name, { create: true })).createWritable();
  await w.write(text);
  await w.close();
  const ours: string[] = [];
  for await (const e of f.values()) if (e.kind === 'file' && NAME.test(e.name)) ours.push(e.name);
  for (const old of ours.sort().reverse().slice(KEEP)) await f.removeEntry(old);
  return 'saved';
}

/** Called by the app shell while it's open: saves any new backup to the chosen folder, quietly. */
export async function autoSave(): Promise<boolean> {
  const f = await getFolder();
  if (!f) return false;
  try { return (await saveToFolder(f)) === 'saved'; } catch { return false; }
}

/** The device backup controls for a screen: what's set up here, and the actions. */
export function useDeviceBackup(onChange: () => void) {
  const [folder, setFolder] = useState<Folder | null>(null);
  const [perm, setPerm] = useState<Perm | null>(null);
  useEffect(() => {
    getFolder().then(async (f) => { if (f) { setFolder(f); setPerm(await f.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt' as Perm)); } });
  }, []);
  return {
    supported: canUseFolder(),
    folderName: folder?.name ?? null,
    /** The browser forgot the permission (it often does after a restart); one click gives it back. */
    needsPermission: !!folder && perm !== 'granted',
    choose: async () => {
      let f: Folder;
      try {
        f = await (window as unknown as { showDirectoryPicker: (o: object) => Promise<Folder> }).showDirectoryPicker({ id: 'little-dipper-backups', mode: 'readwrite', startIn: 'documents' });
      } catch (e) {
        if ((e as Error).name === 'AbortError') return; // closed the picker: nothing to do
        throw e;
      }
      await keepFolder(f);
      setFolder(f); setPerm('granted');
      await saveToFolder(f, true);
      onChange();
    },
    allow: async () => {
      if (!folder) return;
      const p = await folder.requestPermission({ mode: 'readwrite' });
      setPerm(p);
      if (p === 'granted') { await saveToFolder(folder, true); onChange(); }
    },
    stop: async () => { await keepFolder(null); setFolder(null); setPerm(null); },
    download: async () => { await downloadFresh(); onChange(); },
  };
}
