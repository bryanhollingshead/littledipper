/**
 * Thin repository layer. Every record is a plain JSON document with a string _id,
 * so the backing store is swappable: MongoDB in production, a local JSON file for
 * development or tiny self-hosted installs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MongoClient, type Db } from 'mongodb';

export const COLLECTIONS = [
  'nodes', 'owners', 'fields', 'contacts', 'nodeLinks', 'grants',
  'connectionRequests', 'invites', 'apiKeys', 'publicProfile', 'audit', 'challenges', 'backups',
  'records', 'domainDefs', 'messages', 'files',
] as const;
export type Collection = (typeof COLLECTIONS)[number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Doc = { _id: string; [k: string]: any };
export type Filter = Record<string, unknown>;
export type FindOpts = { sort?: Record<string, 1 | -1>; limit?: number };

export interface Store {
  readonly kind: 'mongo' | 'file';
  find<T extends Doc = Doc>(coll: Collection, filter?: Filter, opts?: FindOpts): Promise<T[]>;
  findOne<T extends Doc = Doc>(coll: Collection, filter: Filter): Promise<T | null>;
  get<T extends Doc = Doc>(coll: Collection, id: string): Promise<T | null>;
  insert<T extends Doc>(coll: Collection, doc: T): Promise<T>;
  /** Shallow $set of the given keys; keys whose value is undefined are removed. */
  update(coll: Collection, id: string, patch: Record<string, unknown>): Promise<void>;
  remove(coll: Collection, id: string): Promise<void>;
  removeMany(coll: Collection, filter: Filter): Promise<number>;
  count(coll: Collection, filter?: Filter): Promise<number>;
  dump(): Promise<Record<string, Doc[]>>;
  restore(data: Record<string, Doc[]>): Promise<void>;
  /**
   * File contents (receipt photos, PDFs), kept apart from documents so the JSON store and
   * backups stay small. Callers encrypt before putting. Not part of dump() or restore().
   */
  putBlob(id: string, data: Buffer): Promise<void>;
  getBlob(id: string): Promise<Buffer | null>;
  deleteBlob(id: string): Promise<void>;
  close(): Promise<void>;
}

// ── filter matching for the file store (equality, $in, $ne, $exists) ──

function matches(doc: Doc, filter: Filter = {}): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    const v = doc[k];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ('$in' in c) return (c.$in as unknown[]).includes(v);
      if ('$ne' in c) return v !== c.$ne;
      if ('$exists' in c) return (v !== undefined) === c.$exists;
    }
    return v === cond;
  });
}

function sortDocs(docs: Doc[], sort?: Record<string, 1 | -1>) {
  if (!sort) return docs;
  const [[k, dir]] = Object.entries(sort);
  return docs.sort((a, b) => (a[k] < b[k] ? -dir : a[k] > b[k] ? dir : 0));
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

class FileStore implements Store {
  readonly kind = 'file' as const;
  private data: Record<string, Record<string, Doc>> = {};
  private mtime = 0;
  constructor(private file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.load();
  }
  private load() {
    if (existsSync(this.file)) {
      this.data = JSON.parse(readFileSync(this.file, 'utf8'));
      this.mtime = statSync(this.file).mtimeMs;
    }
    for (const c of COLLECTIONS) this.data[c] ??= {};
  }
  /** Pick up writes made by the CLI while the server is running. */
  private fresh() {
    if (existsSync(this.file) && statSync(this.file).mtimeMs > this.mtime) this.load();
  }
  private save() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.mtime = statSync(this.file).mtimeMs;
  }
  async find<T extends Doc>(coll: Collection, filter?: Filter, opts: FindOpts = {}) {
    this.fresh();
    let docs = sortDocs(Object.values(this.data[coll]).filter((d) => matches(d, filter)), opts.sort);
    if (opts.limit) docs = docs.slice(0, opts.limit);
    return clone(docs) as T[];
  }
  async findOne<T extends Doc>(coll: Collection, filter: Filter) {
    return ((await this.find<T>(coll, filter, { limit: 1 }))[0] ?? null) as T | null;
  }
  async get<T extends Doc>(coll: Collection, id: string) {
    this.fresh();
    return clone(this.data[coll][id] ?? null) as T | null;
  }
  async insert<T extends Doc>(coll: Collection, doc: T) {
    this.fresh();
    if (this.data[coll][doc._id]) throw new Error(`duplicate _id ${doc._id} in ${coll}`);
    this.data[coll][doc._id] = clone(doc);
    this.save();
    return doc;
  }
  async update(coll: Collection, id: string, patch: Record<string, unknown>) {
    this.fresh();
    const d = this.data[coll][id];
    if (!d) return;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete d[k];
      else d[k] = clone(v);
    }
    this.save();
  }
  async remove(coll: Collection, id: string) {
    this.fresh();
    delete this.data[coll][id];
    this.save();
  }
  async removeMany(coll: Collection, filter: Filter) {
    this.fresh();
    const ids = Object.values(this.data[coll]).filter((d) => matches(d, filter)).map((d) => d._id);
    ids.forEach((id) => delete this.data[coll][id]);
    if (ids.length) this.save();
    return ids.length;
  }
  async count(coll: Collection, filter?: Filter) {
    return (await this.find(coll, filter)).length;
  }
  async dump() {
    this.fresh();
    return Object.fromEntries(COLLECTIONS.map((c) => [c, clone(Object.values(this.data[c]))]));
  }
  async restore(data: Record<string, Doc[]>) {
    for (const c of COLLECTIONS) this.data[c] = Object.fromEntries((data[c] || []).map((d) => [d._id, d]));
    this.save();
  }
  // One file per blob next to store.json. Ids are generated by us, never user input.
  private blobPath(id: string) {
    if (!/^[a-z]+_[a-z0-9]+$/.test(id)) throw new Error('bad blob id');
    return path.join(path.dirname(this.file), 'blobs', id);
  }
  async putBlob(id: string, data: Buffer) {
    mkdirSync(path.dirname(this.blobPath(id)), { recursive: true });
    writeFileSync(this.blobPath(id), data, { mode: 0o600 });
  }
  async getBlob(id: string) {
    const f = this.blobPath(id);
    return existsSync(f) ? readFileSync(f) : null;
  }
  async deleteBlob(id: string) {
    const f = this.blobPath(id);
    if (existsSync(f)) unlinkSync(f);
  }
  async close() {}
}

class MongoStore implements Store {
  readonly kind = 'mongo' as const;
  private constructor(private client: MongoClient, private db: Db) {}
  static async connect(uri: string, dbName: string) {
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(dbName);
    await db.collection('audit').createIndex({ at: -1 });
    await db.collection('fields').createIndex({ key: 1 }, { unique: true });
    await db.collection('apiKeys').createIndex({ hash: 1 });
    await db.collection('records').createIndex({ domain: 1, validFrom: -1 });
    await db.collection('messages').createIndex({ contactId: 1, createdAt: -1 });
    await db.collection('messages').createIndex({ status: 1 });
    await db.collection('files').createIndex({ recordId: 1 });
    return new MongoStore(client, db);
  }
  // The driver's types assume ObjectId _ids; ours are strings, so loosen them here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private c(coll: Collection) { return this.db.collection<any>(coll); }
  async find<T extends Doc>(coll: Collection, filter: Filter = {}, opts: FindOpts = {}) {
    let cur = this.c(coll).find(filter);
    if (opts.sort) cur = cur.sort(opts.sort);
    if (opts.limit) cur = cur.limit(opts.limit);
    return (await cur.toArray()) as T[];
  }
  async findOne<T extends Doc>(coll: Collection, filter: Filter) {
    return (await this.c(coll).findOne(filter)) as T | null;
  }
  async get<T extends Doc>(coll: Collection, id: string) {
    return (await this.c(coll).findOne({ _id: id })) as T | null;
  }
  async insert<T extends Doc>(coll: Collection, doc: T) {
    await this.c(coll).insertOne(doc);
    return doc;
  }
  async update(coll: Collection, id: string, patch: Record<string, unknown>) {
    const $set: Record<string, unknown> = {}, $unset: Record<string, ''> = {};
    for (const [k, v] of Object.entries(patch)) (v === undefined ? ($unset[k] = '') : ($set[k] = v));
    const upd: Record<string, unknown> = {};
    if (Object.keys($set).length) upd.$set = $set;
    if (Object.keys($unset).length) upd.$unset = $unset;
    if (Object.keys(upd).length) await this.c(coll).updateOne({ _id: id }, upd);
  }
  async remove(coll: Collection, id: string) {
    await this.c(coll).deleteOne({ _id: id });
  }
  async removeMany(coll: Collection, filter: Filter) {
    return (await this.c(coll).deleteMany(filter)).deletedCount;
  }
  async count(coll: Collection, filter: Filter = {}) {
    return this.c(coll).countDocuments(filter);
  }
  async dump() {
    const out: Record<string, Doc[]> = {};
    for (const c of COLLECTIONS) out[c] = (await this.c(c).find({}).toArray()) as Doc[];
    return out;
  }
  async restore(data: Record<string, Doc[]>) {
    for (const c of COLLECTIONS) {
      await this.c(c).deleteMany({});
      if (data[c]?.length) await this.c(c).insertMany(data[c]);
    }
  }
  // A separate collection outside COLLECTIONS, so dump() and backups skip it. Files are capped well under 16 MB.
  async putBlob(id: string, data: Buffer) {
    await this.db.collection<{ _id: string; data: Buffer }>('blobs').replaceOne({ _id: id }, { data }, { upsert: true });
  }
  async getBlob(id: string) {
    const d = await this.db.collection<{ _id: string; data: { buffer: Uint8Array } }>('blobs').findOne({ _id: id });
    return d ? Buffer.from(d.data.buffer) : null;
  }
  async deleteBlob(id: string) {
    await this.db.collection<{ _id: string }>('blobs').deleteOne({ _id: id });
  }
  async close() {
    await this.client.close();
  }
}

export async function openStore(opts: { mongoUri: string; mongoDb: string; dataDir: string }): Promise<Store> {
  if (opts.mongoUri) return MongoStore.connect(opts.mongoUri, opts.mongoDb);
  return new FileStore(path.join(opts.dataDir, 'store.json'));
}
