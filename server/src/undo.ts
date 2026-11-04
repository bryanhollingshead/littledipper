/**
 * Undo what an app or assistant changed, field by field, from record history.
 *
 * The rule: undo never overwrites anyone's later edits. For each field the app changed, if the field still holds
 * the app's value it goes back to what it was before; if someone changed it since, it's left alone and reported
 * as skipped. A record the app created is removed (restorable for 30 days, like any deletion) unless someone else
 * changed it since. Nothing is rewritten: undoing is a new change in history, by the owner.
 */
import { ctx } from './ctx.js';
import { getDomain, recordOut, recordVersion, syncDerived, versionRecord, type RecordDoc } from './domains/records.js';
import { recordRemoved } from './documents.js';
import type { Actor, VersionDoc } from './domains/types.js';

/** A run of an app's changes with no gap longer than this is one session. */
export const SESSION_GAP_MS = 30 * 60_000;

const FIELDS = ['validFrom', 'validTo', 'notes'] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const isApp = (v: VersionDoc, keyId: string) => v.by.type === 'app' && v.by.id === keyId;

export type UndoResult = {
  recordId: string; domain: string; title: string;
  outcome: 'reverted' | 'removed' | 'skipped' | 'nothing';
  reverted: string[];
  /** Fields left alone because someone changed them after the app did. */
  skipped: string[];
  reason?: string;
};

/** Every change by one app key, oldest first. */
export async function appVersions(keyId: string) {
  return (await ctx.store.find<VersionDoc>('recordVersions', {}, { sort: { at: 1 } })).filter((v) => isApp(v, keyId) && v.action !== 'delete');
}

/** Group an app's changes into sessions: newest first. */
export function sessionsOf(versions: VersionDoc[]) {
  const out: VersionDoc[][] = [];
  for (const v of versions) {
    const cur = out.at(-1);
    if (cur && Date.parse(v.at) - Date.parse(cur.at(-1)!.at) <= SESSION_GAP_MS) cur.push(v);
    else out.push([v]);
  }
  return out.reverse();
}

/** Undo the given changes (all by one key) to one record. */
export async function undoOnRecord(recordId: string, changes: VersionDoc[], keyId: string, owner: Actor): Promise<UndoResult> {
  const all = (await ctx.store.find<VersionDoc>('recordVersions', { recordId }, { sort: { at: 1 } }));
  const ids = new Set(changes.map((c) => c._id));
  const mine = all.filter((v) => ids.has(v._id));
  const d = await getDomain(mine[0]?.domain ?? all[0]?.domain ?? '');
  const current = await ctx.store.get<RecordDoc>('records', recordId);
  const title = d ? recordOut(d, current ?? versionRecord(all.at(-1)!)).title : recordId;
  const base = { recordId, domain: d?.id ?? '', title, reverted: [] as string[], skipped: [] as string[] };
  if (!d || !mine.length) return { ...base, outcome: 'nothing' };
  if (!current) return { ...base, outcome: 'skipped', reason: 'It was deleted since.' };

  const first = mine[0], last = mine.at(-1)!;
  const label = (k: string) => d.parts.find((p) => p.key === k)?.label ?? { validFrom: 'From', validTo: 'To', notes: 'Notes' }[k] ?? k;

  // The app created it: remove it, unless someone else has changed it since.
  if (first.action === 'create') {
    const later = all.filter((v) => v.at > first.at && !isApp(v, keyId));
    if (later.length) return { ...base, outcome: 'skipped', reason: 'Someone else changed it after it was added, so it was kept.' };
    await recordVersion(current, 'delete', owner);
    await ctx.store.remove('records', recordId);
    await recordRemoved(recordId);
    await syncDerived(d.id);
    return { ...base, outcome: 'removed' };
  }

  // Fields the app changed, comparing each of its versions with the one before it.
  const before = all[all.indexOf(first) - 1];
  if (!before) return { ...base, outcome: 'nothing' };
  const touched = new Set<string>();
  for (const v of mine) {
    const prev = all[all.indexOf(v) - 1];
    if (!prev) continue;
    for (const k of new Set([...Object.keys(v.data), ...Object.keys(prev.data)])) if (!same(v.data[k], prev.data[k])) touched.add(`data.${k}`);
    for (const k of FIELDS) if (!same(v[k], prev[k])) touched.add(k);
  }

  const next: RecordDoc = { ...current, data: { ...current.data } };
  const reverted: string[] = [], skipped: string[] = [];
  for (const f of touched) {
    const [now, theirs, was] = f.startsWith('data.')
      ? [current.data[f.slice(5)], last.data[f.slice(5)], before.data[f.slice(5)]]
      : [current[f as typeof FIELDS[number]], last[f as typeof FIELDS[number]], before[f as typeof FIELDS[number]]];
    const name = label(f.replace(/^data\./, ''));
    if (!same(now, theirs)) { skipped.push(name); continue; }
    if (f.startsWith('data.')) { if (was === undefined) delete next.data[f.slice(5)]; else next.data[f.slice(5)] = was; }
    else (next as Record<string, unknown>)[f] = was ?? (f === 'notes' ? '' : null);
    reverted.push(name);
  }
  if (!reverted.length) return { ...base, skipped, outcome: skipped.length ? 'skipped' : 'nothing', ...(skipped.length ? { reason: 'Someone changed these since.' } : {}) };

  next.updatedBy = owner;
  next.updatedAt = new Date().toISOString();
  const { _id, ...rest } = next;
  await ctx.store.update('records', _id, { ...rest });
  await recordVersion(next, 'update', owner);
  await syncDerived(d.id);
  return { ...base, title: recordOut(d, next).title, reverted, skipped, outcome: 'reverted' };
}

/** Undo a set of changes by one key across records. */
export async function undoChanges(changes: VersionDoc[], keyId: string, owner: Actor) {
  const byRecord = new Map<string, VersionDoc[]>();
  for (const c of changes) byRecord.set(c.recordId, [...(byRecord.get(c.recordId) ?? []), c]);
  const results: UndoResult[] = [];
  for (const [recordId, cs] of byRecord) results.push(await undoOnRecord(recordId, cs, keyId, owner));
  return results;
}
