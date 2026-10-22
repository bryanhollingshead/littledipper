/**
 * Documents and their pages, assistant suggestions, expiring share links, and the documents export.
 *
 *   POST /api/v1/documents?name=license.jpg&link=ids:rec_…    body: the bytes, type in Content-Type
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit, ownerActor } from '../audit.js';
import { bad, HttpError, notFound, rateLimit, requireOwner, requireSession, type Principal } from '../auth.js';
import { ctx } from '../ctx.js';
import { newId, randomToken, safeEqual, sha256 } from '../crypto.js';
import {
  addPage, addSuggestion, canSee, checkDate, checkKind, checkLinks, checkSuggestion, checkText, createDocument, deleteDocument, docRef, docScopes,
  documentKinds, documentOr404, documentOut, dropSuggestion, linkDocument, parseLink, removePage, type DocumentDoc,
} from '../documents.js';
import { buildRecord, getDomain, listDomains, recordOut, syncDerived, type RecordDoc, type RecordInput } from '../domains/records.js';
import { FILE_TYPES, MAX_FILE_BYTES, readFile, saveFile, type FileDoc, type Source } from '../files.js';
import { canonicalUrl, getNode } from '../node.js';

type ShareDoc = { _id: string; documentId: string; tokenHash: string; expiresAt: string; revokedAt: string | null; views: number; lastViewedAt: string | null; createdAt: string };
const SHARE_HOURS = [1, 24, 24 * 7, 24 * 30];

const sourceOf = (p: Principal): Source => ({ type: p.isSession ? 'owner' : 'app', id: p.key._id });
const who = (p: Principal) => (p.isSession ? 'You' : 'An app');

function bodyBytes(req: FastifyRequest) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'unsupported_type', 'Send a photo (JPEG, PNG, WebP, HEIC) or a PDF as the request body');
  return { type, data: req.body };
}

/** Minimal ustar archive: one entry per file, padded to 512-byte blocks. */
function tar(entries: { name: string; data: Buffer; mtime: Date }[]) {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    const name = e.name.replace(/[^\x20-\x7e]/g, '_').slice(0, 99);
    h.write(name, 0, 'ascii');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(e.data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(e.mtime.getTime() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

async function sendFile(reply: import('fastify').FastifyReply, f: FileDoc, download: boolean) {
  const got = await readFile(f._id);
  if (!got) throw notFound('file_not_found');
  reply.header('content-type', f.type);
  reply.header('content-disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  reply.header('x-content-type-options', 'nosniff');
  return got.data;
}

export default async function documentRoutes(app: FastifyInstance) {
  // Raw bytes for these types, only in this plugin. Anything else is refused before it's read.
  app.addContentTypeParser(FILE_TYPES, { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES }, (_req, body, done) => done(null, body));

  const docFor = async (req: FastifyRequest, write: boolean) => {
    const doc = await documentOr404((req.params as { id: string }).id);
    const p = await requireOwner(req, docScopes(doc, write));
    return { doc, p };
  };

  // ── library ──────────────────────────────────────────────────────────
  app.get('/api/v1/documents/kinds', async (req) => {
    await requireOwner(req, ['documents:read', 'records:read']);
    return documentKinds();
  });

  app.get('/api/v1/documents', async (req) => {
    const p = await requireOwner(req, ['documents:read', 'records:read', ...(await listDomains()).map((d) => `${d.id}:read`)]);
    const q = req.query as { status?: string; kind?: string; domain?: string; recordId?: string; q?: string };
    let docs = (await ctx.store.find<DocumentDoc>('documents', {}, { sort: { createdAt: -1 } })).filter((d) => canSee(p, d));
    if (q.status) docs = docs.filter((d) => d.status === q.status);
    if (q.kind) docs = docs.filter((d) => d.kind === q.kind);
    if (q.domain) docs = docs.filter((d) => d.links.some((l) => l.domain === q.domain && (!q.recordId || l.recordId === q.recordId)));
    const items = await Promise.all(docs.map(documentOut));
    const needle = q.q?.trim().toLowerCase();
    return {
      items: needle ? items.filter((d) => [d.title, d.notes, d.text, ...d.pages.map((x) => x.name), ...d.links.map((l) => l.title ?? '')].join(' ').toLowerCase().includes(needle)) : items,
    };
  });

  /** One upload, one new document. With ?link=domain:recordId it's filed on that entry. */
  app.post('/api/v1/documents', async (req, reply) => {
    const q = req.query as { name?: string; title?: string; kind?: string; status?: string; date?: string; link?: string };
    const links = parseLink(q.link);
    const p = await requireOwner(req, docScopes({ links }, true));
    const { type, data } = bodyBytes(req);
    const name = String(q.name || 'document');
    const page = await saveFile(name, type, data, sourceOf(p));
    const doc = await createDocument({ title: q.title || name.replace(/\.\w+$/, ''), kind: q.kind, status: q.status, date: q.date, links, page, from: sourceOf(p) });
    await audit({ actor: ownerActor(p.key._id), action: 'document.create', resource: `documents/${doc._id}`, text: `${who(p)} added the document ${doc.title}`, tone: 'owner' });
    reply.code(201);
    return documentOut(doc);
  });

  app.get('/api/v1/documents/:id', async (req) => documentOut((await docFor(req, false)).doc));

  app.patch('/api/v1/documents/:id', async (req) => {
    const { doc, p } = await docFor(req, true);
    const b = (req.body || {}) as Partial<{ title: string; kind: string; status: string; date: string | null; notes: string; text: string; links: unknown }>;
    const set: Partial<DocumentDoc> = { updatedAt: new Date().toISOString() };
    if (b.title !== undefined) set.title = String(b.title).trim().slice(0, 200) || doc.title;
    if (b.kind !== undefined) set.kind = checkKind(b.kind);
    if (b.status !== undefined) { if (b.status !== 'inbox' && b.status !== 'filed') throw bad('invalid_value', 'status: inbox or filed'); set.status = b.status; }
    if (b.date !== undefined) set.date = checkDate(b.date);
    if (b.notes !== undefined) set.notes = String(b.notes).slice(0, 10000);
    if (b.text !== undefined) set.text = checkText(b.text);
    if (b.links !== undefined) {
      set.links = await checkLinks(b.links);
      // A key limited to one category can't move documents into categories it can't see.
      const s = p.key.scopes;
      if (!s.includes('admin:*') && !s.includes('documents:write') && !s.includes('records:write') && set.links.some((l) => !s.includes(`${l.domain}:write`))) throw new HttpError(403, 'insufficient_scope', 'This key can’t link documents there');
    }
    await ctx.store.update('documents', doc._id, set);
    return documentOut({ ...doc, ...set });
  });

  app.delete('/api/v1/documents/:id', async (req) => {
    const { doc, p } = await docFor(req, true);
    await deleteDocument(doc);
    await audit({ actor: ownerActor(p.key._id), action: 'document.delete', resource: `documents/${doc._id}`, text: `${who(p)} deleted the document ${doc.title}`, tone: 'owner' });
    return { deleted: true };
  });

  // ── pages ────────────────────────────────────────────────────────────
  app.post('/api/v1/documents/:id/pages', async (req, reply) => {
    const { doc, p } = await docFor(req, true);
    const { type, data } = bodyBytes(req);
    const page = await saveFile(String((req.query as { name?: string }).name || 'page'), type, data, sourceOf(p), doc._id);
    reply.code(201);
    return documentOut(await addPage(doc, page));
  });

  app.delete('/api/v1/documents/:id/pages/:fileId', async (req) => {
    const { doc } = await docFor(req, true);
    return documentOut(await removePage(doc, (req.params as { fileId: string }).fileId));
  });

  app.get('/api/v1/files/:id', async (req, reply) => {
    const f = await ctx.store.get<FileDoc>('files', (req.params as { id: string }).id);
    const doc = f?.documentId ? await ctx.store.get<DocumentDoc>('documents', f.documentId) : null;
    if (!f || !doc) throw notFound('file_not_found');
    await requireOwner(req, docScopes(doc, false));
    // A file id never changes contents.
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(await sendFile(reply, f, (req.query as { download?: string }).download === '1'));
  });

  // ── suggestions: an assistant proposes, the owner decides ─────────────
  app.post('/api/v1/documents/:id/suggestions', async (req, reply) => {
    const { doc, p } = await docFor(req, true);
    const s = await checkSuggestion((req.body || {}) as Record<string, unknown>, sourceOf(p));
    const d = (await getDomain(s.domain))!;
    // Fail now, not when the owner clicks Accept.
    const existing = s.recordId ? await ctx.store.get<RecordDoc & { [k: string]: unknown }>('records', s.recordId) as RecordDoc : null;
    await buildRecord(d, { data: s.data, validFrom: s.validFrom, validTo: s.validTo }, existing, { type: p.isSession ? 'owner' : 'app', id: p.key._id });
    reply.code(201);
    return documentOut(await addSuggestion(doc, s));
  });

  /** Owner only: create or update the record (optionally with edits), link the document, file it. */
  app.post('/api/v1/documents/:id/suggestions/:sid/accept', async (req) => {
    const p = await requireSession(req);
    const doc = await documentOr404((req.params as { id: string }).id);
    const s = doc.suggestions.find((x) => x.id === (req.params as { sid: string }).sid);
    if (!s) throw notFound('suggestion_not_found');
    const d = await getDomain(s.domain);
    if (!d) throw notFound('not_found');
    const edits = (req.body || {}) as RecordInput;
    const input: RecordInput = { data: edits.data ?? s.data, validFrom: edits.validFrom ?? s.validFrom, validTo: edits.validTo ?? s.validTo, notes: edits.notes };
    const existing = s.recordId ? (await ctx.store.get<RecordDoc & { [k: string]: unknown }>('records', s.recordId)) as RecordDoc | null : null;
    if (s.recordId && !existing) throw new HttpError(409, 'record_gone', 'That entry no longer exists');
    // The record remembers it came from the assistant's key.
    const rec = await buildRecord(d, input, existing, { type: s.by.type === 'owner' ? 'owner' : 'app', id: s.by.id });
    if (existing) { const { _id, ...rest } = rec; await ctx.store.update('records', _id, { ...rest }); }
    else await ctx.store.insert('records', rec);
    await syncDerived(d.id);
    const linked = await linkDocument(await dropSuggestion(doc, s.id), { domain: d.id, recordId: rec._id });
    const title = recordOut(d, rec).title;
    await audit({ actor: ownerActor(p.key._id), action: 'document.suggestion.accept', resource: `documents/${doc._id}`, text: `You accepted a suggestion from ${doc.title}: ${title} in ${d.label}`, tone: 'owner' });
    return { document: await documentOut(linked), record: recordOut(d, rec) };
  });

  app.delete('/api/v1/documents/:id/suggestions/:sid', async (req) => {
    const { doc } = await docFor(req, true);
    return documentOut(await dropSuggestion(doc, (req.params as { sid: string }).sid));
  });

  // ── share links for people without a Little Dipper ────────────────────
  // Owner's browser only: a public link is an outward-facing act.
  app.get('/api/v1/documents/:id/shares', async (req) => {
    await requireSession(req);
    const doc = await documentOr404((req.params as { id: string }).id);
    const shares = await ctx.store.find<ShareDoc>('shares', { documentId: doc._id }, { sort: { createdAt: -1 } });
    return { items: shares.map(({ tokenHash, ...s }) => ({ id: s._id, ...s, active: !s.revokedAt && s.expiresAt > new Date().toISOString() })) };
  });

  app.post('/api/v1/documents/:id/shares', async (req, reply) => {
    const p = await requireSession(req);
    const doc = await documentOr404((req.params as { id: string }).id);
    const hours = Number((req.body as { hours?: number } | null)?.hours ?? 24 * 7);
    if (!SHARE_HOURS.includes(hours)) throw bad('invalid_value', `hours: one of ${SHARE_HOURS.join(', ')}`);
    const secret = randomToken();
    const share: ShareDoc = { _id: newId('shr'), documentId: doc._id, tokenHash: sha256(secret), expiresAt: new Date(Date.now() + hours * 3600_000).toISOString(), revokedAt: null, views: 0, lastViewedAt: null, createdAt: new Date().toISOString() };
    await ctx.store.insert('shares', share);
    await audit({ actor: ownerActor(p.key._id), action: 'document.share', resource: `documents/${doc._id}`, text: `You created a share link for ${doc.title}, expiring ${share.expiresAt.slice(0, 10)}`, tone: 'owner' });
    reply.code(201);
    return { id: share._id, url: `${canonicalUrl(await getNode())}/s/${share._id}.${secret}`, expiresAt: share.expiresAt };
  });

  app.delete('/api/v1/documents/:id/shares/:shareId', async (req) => {
    const p = await requireSession(req);
    const s = await ctx.store.get<ShareDoc>('shares', (req.params as { shareId: string }).shareId);
    if (!s || s.documentId !== (req.params as { id: string }).id) throw notFound('share_not_found');
    await ctx.store.update('shares', s._id, { revokedAt: new Date().toISOString() });
    await audit({ actor: ownerActor(p.key._id), action: 'document.unshare', resource: `documents/${s.documentId}`, text: 'You turned off a share link', tone: 'owner' });
    return { revoked: true };
  });

  const openShare = async (req: FastifyRequest) => {
    rateLimit(req, 'share-view', 300, 10 * 60_000);
    const [id, secret] = String((req.params as { token: string }).token).split('.');
    const s = await ctx.store.get<ShareDoc>('shares', id || '');
    const ok = !!s && !!secret && safeEqual(s.tokenHash, sha256(secret)) && !s.revokedAt && s.expiresAt > new Date().toISOString();
    const doc = ok ? await ctx.store.get<DocumentDoc>('documents', s!.documentId) : null;
    if (!doc) throw new HttpError(404, 'share_unavailable', 'This link has expired or was turned off');
    return { s: s!, doc };
  };

  app.get('/public/v1/shared/:token', async (req, reply) => {
    const { s, doc } = await openShare(req);
    await ctx.store.update('shares', s._id, { views: s.views + 1, lastViewedAt: new Date().toISOString() });
    await audit({ actor: { type: 'public', id: s._id }, action: 'document.view', resource: `documents/${doc._id}`, text: `Someone opened your share link for ${doc.title}`, tone: 'system', ip: req.ip });
    const owner = await ctx.store.findOne<{ _id: string; displayName: string }>('owners', {});
    reply.header('x-robots-tag', 'noindex');
    return { title: doc.title, kind: doc.kind, date: doc.date, pages: doc.pages, expiresAt: s.expiresAt, sharedBy: owner?.displayName ?? null };
  });

  app.get('/public/v1/shared/:token/files/:fileId', async (req, reply) => {
    const { doc } = await openShare(req);
    const fileId = (req.params as { fileId: string }).fileId;
    const f = doc.pages.some((x) => x.id === fileId) ? await ctx.store.get<FileDoc>('files', fileId) : null;
    if (!f) throw notFound('file_not_found');
    reply.header('cache-control', 'private, no-store');
    reply.header('x-robots-tag', 'noindex');
    return reply.send(await sendFile(reply, f, (req.query as { download?: string }).download === '1'));
  });

  // ── export: every document's pages, decrypted, as a .tar ──────────────
  app.get('/api/v1/export/documents', async (req, reply) => {
    const p = await requireOwner(req, 'export');
    const docs = await ctx.store.find<DocumentDoc>('documents', {}, { sort: { createdAt: 1 } });
    const entries: { name: string; data: Buffer; mtime: Date }[] = [];
    const manifest = [];
    for (const d of docs) {
      const dir = `documents/${d._id}-${d.title.replace(/[^\w.-]+/g, '_').slice(0, 40)}`;
      const files = [];
      for (const [i, pg] of d.pages.entries()) {
        const got = await readFile(pg.id);
        if (!got) continue;
        const name = `${dir}/${String(i + 1).padStart(2, '0')}-${pg.name.replace(/[^\w.-]+/g, '_')}`;
        entries.push({ name, data: got.data, mtime: new Date(d.createdAt) });
        files.push(name);
      }
      manifest.push({ ...docRef(d), links: d.links, notes: d.notes, files });
    }
    entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)), mtime: new Date() });
    await audit({ actor: ownerActor(p.key._id), action: 'export.documents', resource: 'documents', text: `Documents exported · ${docs.length} documents`, tone: 'owner' });
    reply.header('content-type', 'application/x-tar');
    reply.header('content-disposition', `attachment; filename="little-dipper-documents-${new Date().toISOString().slice(0, 10)}.tar"`);
    return reply.send(tar(entries));
  });
}
