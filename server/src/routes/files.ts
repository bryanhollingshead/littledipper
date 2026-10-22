/**
 * Uploading and reading attached files. A file is uploaded on its own first (raw bytes, its type in
 * Content-Type), then referenced from a record's files part. Domain scopes guard it.
 *
 *   POST /api/v1/files?domain=receipts&name=lunch.jpg   body: the bytes
 */
import type { FastifyInstance } from 'fastify';
import { audit, ownerActor } from '../audit.js';
import { HttpError, bad, notFound, requireOwner } from '../auth.js';
import { getDomain } from '../domains/records.js';
import { FILE_TYPES, MAX_FILE_BYTES, deleteFile, fileOut, readFile, saveFile, type FileDoc } from '../files.js';
import { ctx } from '../ctx.js';

const scopes = (domain: string, write: boolean) => (write ? [`${domain}:write`, 'records:write'] : [`${domain}:read`, 'records:read']);

export default async function fileRoutes(app: FastifyInstance) {
  // Raw bytes for these types, only in this plugin. Anything else is refused before it's read.
  app.addContentTypeParser(FILE_TYPES, { parseAs: 'buffer', bodyLimit: MAX_FILE_BYTES }, (_req, body, done) => done(null, body));

  app.post('/api/v1/files', async (req, reply) => {
    const q = req.query as { domain?: string; name?: string };
    const d = q.domain ? await getDomain(q.domain) : null;
    if (!d) throw bad('domain_required', 'Say which category the file belongs to: ?domain=receipts');
    const p = await requireOwner(req, scopes(d.id, true));
    if (!d.parts.some((x) => x.type === 'files')) throw bad('no_files', `${d.label} doesn’t take files`);
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'unsupported_type', 'Upload a photo (JPEG, PNG, WebP, HEIC) or a PDF as the request body');
    const f = await saveFile(d.id, String(q.name || 'file'), type, req.body, { type: p.isSession ? 'owner' : 'app', id: p.key._id });
    await audit({ actor: ownerActor(p.key._id), action: 'file.upload', resource: `files/${f._id}`, text: `${p.isSession ? 'You' : 'An app'} uploaded ${f.name} to ${d.label}`, tone: 'owner' });
    reply.code(201);
    return fileOut(f);
  });

  const fileOr404 = async (id: string) => {
    const f = await ctx.store.get<FileDoc>('files', id);
    if (!f) throw notFound('file_not_found');
    return f;
  };

  app.get('/api/v1/files/:id/meta', async (req) => {
    const f = await fileOr404((req.params as { id: string }).id);
    await requireOwner(req, scopes(f.domain, false));
    return fileOut(f);
  });

  app.get('/api/v1/files/:id', async (req, reply) => {
    const f = await fileOr404((req.params as { id: string }).id);
    await requireOwner(req, scopes(f.domain, false));
    const got = await readFile(f._id);
    if (!got) throw notFound('file_not_found');
    const download = (req.query as { download?: string }).download === '1';
    reply.header('content-type', f.type);
    reply.header('content-disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    reply.header('x-content-type-options', 'nosniff');
    // A file id never changes contents.
    reply.header('cache-control', 'private, max-age=31536000, immutable');
    return reply.send(got.data);
  });

  // Only uploads not yet on a record. To drop an attached file, save the record without it.
  app.delete('/api/v1/files/:id', async (req) => {
    const f = await fileOr404((req.params as { id: string }).id);
    await requireOwner(req, scopes(f.domain, true));
    if (f.recordId) throw new HttpError(409, 'attached', 'Remove the file from its entry instead');
    await deleteFile(f._id);
    return { deleted: true };
  });
}
