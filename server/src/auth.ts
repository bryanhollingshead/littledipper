import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { ctx } from './ctx.js';
import { newId, randomToken, sha256 } from './crypto.js';
import type { Doc } from './store/index.js';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message || code);
  }
}
export const bad = (code: string, msg?: string) => new HttpError(400, code, msg);
export const notFound = (what = 'not_found') => new HttpError(404, what);

export type ApiKeyDoc = Doc & {
  name: string;
  kind: 'session' | 'app' | 'peer' | 'setup' | 'mfa';
  prefix: string;
  hash: string;
  scopes: string[];
  contactId?: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  label?: string;
};

/** Fixed scopes. Each domain also has its own: {domain}:read and {domain}:write. records:* covers every domain. */
export const SCOPES = ['owner:read', 'owner:write', 'records:read', 'records:write', 'contacts:read', 'contacts:write', 'public:write', 'keys:manage', 'audit:read', 'export', 'messages:read', 'messages:write'] as const;

export const COOKIE = { session: 'ld_session', setup: 'ld_setup', mfa: 'ld_mfa' } as const;

const secure = () => config.hostUrl.startsWith('https://');
export const cookieOpts = (maxAgeSec: number) => ({ path: '/', httpOnly: true, sameSite: 'strict' as const, secure: secure(), maxAge: maxAgeSec });

/** Create a credential. The secret is returned once; only its hash and a display prefix are stored. */
export async function issueKey(opts: { kind: ApiKeyDoc['kind']; name: string; scopes: string[]; ttlSec?: number; contactId?: string; label?: string }) {
  const tag = { session: 'sess', app: 'live', peer: 'peer', setup: 'setup', mfa: 'mfa' }[opts.kind];
  const short = randomToken(3).replace(/[-_]/g, 'x').slice(0, 4).toLowerCase();
  const secret = `ldk_${tag}_${short}_${randomToken(24)}`;
  const doc: ApiKeyDoc = {
    _id: newId('key'), name: opts.name, kind: opts.kind, prefix: secret.slice(0, 14) + '…', hash: sha256(secret), scopes: opts.scopes,
    contactId: opts.contactId, label: opts.label, createdAt: new Date().toISOString(), lastUsedAt: null,
    expiresAt: opts.ttlSec ? new Date(Date.now() + opts.ttlSec * 1000).toISOString() : null, revokedAt: null,
  };
  await ctx.store.insert('apiKeys', doc);
  return { secret, doc };
}

export async function findKey(secret: string | undefined, kinds: ApiKeyDoc['kind'][]): Promise<ApiKeyDoc | null> {
  if (!secret) return null;
  const k = await ctx.store.findOne<ApiKeyDoc>('apiKeys', { hash: sha256(secret) });
  if (!k || k.revokedAt || !kinds.includes(k.kind)) return null;
  if (k.expiresAt && new Date(k.expiresAt).getTime() < Date.now()) return null;
  // Throttle lastUsedAt writes to once a minute.
  if (!k.lastUsedAt || Date.now() - new Date(k.lastUsedAt).getTime() > 60_000) {
    await ctx.store.update('apiKeys', k._id, { lastUsedAt: new Date().toISOString() });
  }
  return k;
}

const bearer = (req: FastifyRequest) => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined;
};

export type Principal = { key: ApiKeyDoc; isSession: boolean };

/** Owner access: the browser session (admin:*) or an app key carrying the scope. */
export async function requireOwner(req: FastifyRequest, scope?: string | string[]): Promise<Principal> {
  const cookieSecret = req.cookies[COOKIE.session];
  let key = await findKey(cookieSecret, ['session']);
  let isSession = !!key;
  if (!key) {
    key = await findKey(bearer(req), ['session', 'app']);
    isSession = key?.kind === 'session';
  }
  if (!key) throw new HttpError(401, 'unauthenticated', 'Sign in required');
  const wanted = scope === undefined ? [] : Array.isArray(scope) ? scope : [scope];
  const ok = key.scopes.includes('admin:*') || wanted.some((s) => key.scopes.includes(s));
  if (!ok) throw new HttpError(403, 'insufficient_scope', wanted.length ? `This key needs ${wanted.join(' or ')}` : 'Owner session required');
  return { key, isSession };
}

/** Routes that only the owner's own browser session may use (credentials, danger zone). */
export async function requireSession(req: FastifyRequest): Promise<Principal> {
  const p = await requireOwner(req);
  if (!p.key.scopes.includes('admin:*')) throw new HttpError(403, 'session_required', 'Use your signed-in browser for this');
  return p;
}

export async function requireSetup(req: FastifyRequest): Promise<ApiKeyDoc> {
  const k = await findKey(req.cookies[COOKIE.setup], ['setup']);
  if (!k) throw new HttpError(401, 'setup_session_expired', 'Your setup session expired. Open the claim link again.');
  return k;
}

/** Either a setup session (during claim) or the owner session. */
export async function requireSetupOrSession(req: FastifyRequest): Promise<'setup' | 'session'> {
  if (await findKey(req.cookies[COOKIE.setup], ['setup'])) return 'setup';
  await requireSession(req);
  return 'session';
}

export async function startSession(reply: FastifyReply, label: string) {
  const { secret } = await issueKey({ kind: 'session', name: label, scopes: ['admin:*'], ttlSec: config.sessionDays * 86400 });
  reply.setCookie(COOKIE.session, secret, cookieOpts(config.sessionDays * 86400));
}

export function deviceLabel(req: FastifyRequest): string {
  const ua = String(req.headers['user-agent'] || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}

// ── tiny in-memory rate limiter ─────────────────────────────────────────
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(req: FastifyRequest, name: string, max: number, windowMs: number) {
  const key = `${name}:${req.ip}`;
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < now) buckets.set(key, { n: 1, reset: now + windowMs });
  else if (++b.n > max) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try again in a few minutes.');
}
