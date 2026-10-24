import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import { config } from './config.js';
import { HttpError } from './auth.js';
import { canonicalUrl, getNode } from './node.js';
import nodeRoutes from './routes/node.js';
import authRoutes from './routes/auth.js';
import ownerRoutes from './routes/owner.js';
import contactRoutes from './routes/contacts.js';
import peerRoutes from './routes/peer.js';
import miscRoutes from './routes/misc.js';
import domainRoutes from './routes/domains.js';
import messageRoutes from './routes/messages.js';
import documentRoutes from './routes/documents.js';
import bigDipperRoutes from './routes/bigDipper.js';
import copyRoutes from './routes/copies.js';

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};

/** A regular file inside root for this URL path, or null. Rejects anything that escapes root. */
function staticFile(root: string, urlPath: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (decoded.includes('\0')) return null;
  const file = path.resolve(root, '.' + path.posix.normalize(decoded));
  if (!file.startsWith(root + path.sep) || file.endsWith(path.sep)) return null;
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}

const API_PREFIXES = ['/api/', '/peer/', '/public/', '/.well-known/'];
const REDIRECT_DAYS = 90;

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(cookie);

  // Old custom domains keep answering with redirects to the canonical address for 90 days.
  app.addHook('onRequest', async (req, reply) => {
    const host = String(req.headers.host || '').toLowerCase();
    if (!host) return;
    const n = await getNode().catch(() => null);
    if (!n) return;
    const current = [new URL(n.addresses.host).host, n.addresses.domain].filter(Boolean);
    if (current.includes(host)) return;
    const retired = n.addressHistory.find((h) => h.to && Date.now() - new Date(h.to).getTime() < REDIRECT_DAYS * 86400_000 && h.address.replace(/^https?:\/\//, '') === host);
    if (retired) reply.redirect(canonicalUrl(n) + req.url, req.method === 'GET' || req.method === 'HEAD' ? 301 : 308);
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ code: err.code, message: err.message });
    const fe = err as FastifyError;
    if (fe.statusCode && fe.statusCode < 500) return reply.code(fe.statusCode).send({ code: fe.code || 'bad_request', message: fe.message });
    req.log.error(err);
    return reply.code(500).send({ code: 'internal', message: 'Something went wrong on this Little Dipper.' });
  });

  await app.register(nodeRoutes);
  await app.register(authRoutes);
  await app.register(ownerRoutes);
  await app.register(contactRoutes);
  await app.register(peerRoutes);
  await app.register(miscRoutes);
  await app.register(messageRoutes);
  await app.register(documentRoutes);
  await app.register(bigDipperRoutes);
  await app.register(copyRoutes);
  await app.register(domainRoutes);

  // The React app: built files from web/dist; every other non-API GET gets index.html.
  const root = config.webDist;
  const indexHtml = existsSync(path.join(root, 'index.html')) ? readFileSync(path.join(root, 'index.html')) : null;
  app.setNotFoundHandler((req, reply) => {
    const urlPath = req.url.split('?')[0];
    const isApi = API_PREFIXES.some((p) => urlPath.startsWith(p));
    if ((req.method === 'GET' || req.method === 'HEAD') && !isApi && config.webDevUrl) return reply.redirect(config.webDevUrl + req.url, 302);
    if ((req.method === 'GET' || req.method === 'HEAD') && !isApi && indexHtml) {
      const file = staticFile(root, urlPath);
      if (file) {
        reply.type(MIME[path.extname(file)] || 'application/octet-stream');
        if (urlPath.startsWith('/assets/')) reply.header('cache-control', 'public, max-age=31536000, immutable');
        return reply.send(readFileSync(file));
      }
      return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(indexHtml);
    }
    return reply.code(404).send({ code: 'not_found', message: `No route for ${req.method} ${urlPath}` });
  });

  return app;
}
