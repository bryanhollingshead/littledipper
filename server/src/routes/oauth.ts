/**
 * OAuth 2.0 for AI assistants: how an assistant platform (Muse, Claude, ChatGPT…) connects to this node's MCP server
 * without anyone copying a key. Each node is its own authorization server, on its own domain.
 *
 * - Discovery: /.well-known/oauth-protected-resource (RFC 9728) and /.well-known/oauth-authorization-server (RFC 8414).
 * - Dynamic client registration (RFC 7591) at /oauth/register. Names are self-reported, so the consent page says
 *   "unverified".
 * - Authorization code with PKCE (S256 only). /oauth/authorize is the web app's consent page: the owner signs in with
 *   their passkey and chooses what the assistant may read, its mode, its secret fields and how long it stays connected.
 * - Tokens: opaque, checked against the store on every call. Access tokens last 30 minutes. Refresh tokens rotate; a
 *   used refresh token still works for a minute (a dropped connection mid-swap mustn't disconnect anyone), after
 *   which reusing it is treated as theft and ends the connection.
 *
 * Every connection is one app key with assistant settings, so Review, provenance, undo and Disconnect work exactly
 * as for a key made by hand.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ctx } from '../ctx.js';
import { audit, ownerActor, systemActor } from '../audit.js';
import { checkAssistant, HttpError, issueKey, rateLimit, requireSession, type ApiKeyDoc, type AssistantSettings } from '../auth.js';
import { newId, randomToken, sha256 } from '../crypto.js';
import { listDomains } from '../domains/records.js';
import { canonicalUrl, getNode } from '../node.js';
import type { Doc } from '../store/index.js';

export const ACCESS_TTL_S = 30 * 60;
const REFRESH_GRACE_MS = 60_000;
const CODE_TTL_MS = 60_000;

/** How long a connection lasts, chosen by the owner on the consent page. */
export const LENGTHS = { hour: 3600, day: 86400, '60d': 60 * 86400, forever: 0 } as const;
type Length = keyof typeof LENGTHS;

/** Everyday: the kinds people most often want help with. Not IDs, health, money or legal. */
export const EVERYDAY = ['names', 'contact_methods', 'residences', 'relationships', 'pets', 'travel', 'events', 'life_events', 'employment', 'education', 'credentials', 'vehicles', 'property', 'memberships', 'insurance', 'receipts', 'preferences'];

type ClientDoc = Doc & { name: string; uri: string | null; redirectUris: string[]; createdAt: string };
type CodeDoc = Doc & { hash: string; clientId: string; redirectUri: string; challenge: string; scopes: string[]; assistant: AssistantSettings; length: Length; ownerKeyId: string; expiresAt: string; usedAt: string | null };
type TokenDoc = Doc & { hash: string; kind: 'access' | 'refresh'; keyId: string; expiresAt: string; usedAt: string | null };

const b64url = (b: Buffer) => b.toString('base64url');
const pkce = (verifier: string) => b64url(Buffer.from(sha256(verifier), 'hex'));
const oauthError = (reply: FastifyReply, error: string, description: string, status = 400) => reply.code(status).send({ error, error_description: description });

async function base() { return canonicalUrl(await getNode()); }

export async function protectedResourceMeta() {
  const b = await base();
  return { resource: `${b}/api/mcp`, authorization_servers: [b], bearer_methods_supported: ['header'], resource_name: 'Little Dipper', scopes_supported: await allScopes() };
}

async function allScopes() {
  return ['records:read', 'records:write', 'documents:read', 'documents:write', ...(await listDomains()).flatMap((d) => [`${d.id}:read`, `${d.id}:write`])];
}

/** Redirect URIs: https anywhere, or http only on this machine (a model the owner runs at home). */
function checkRedirect(u: string) {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

/** The grant the owner chose, turned into scopes. Answer-only assistants get read scopes only. */
export async function scopesFor(choice: { preset: 'everyday' | 'everything' | 'custom'; kinds?: string[]; documents?: boolean }, mode: AssistantSettings['mode']) {
  const known = new Set((await listDomains()).map((d) => d.id));
  const verbs = mode === 'answer' ? ['read'] : ['read', 'write'];
  if (choice.preset === 'everything') return [...verbs.map((v) => `records:${v}`), ...verbs.map((v) => `documents:${v}`)];
  const kinds = (choice.preset === 'everyday' ? EVERYDAY : choice.kinds ?? []).filter((k) => known.has(k));
  const docs = choice.preset === 'everyday' ? true : !!choice.documents;
  if (!kinds.length && !docs) throw new HttpError(400, 'nothing_chosen', 'Choose at least one kind of record');
  return [...kinds.flatMap((k) => verbs.map((v) => `${k}:${v}`)), ...(docs ? verbs.map((v) => `documents:${v}`) : [])];
}

async function issueTokens(keyId: string, keyExpiresAt: string | null) {
  // Tidy as we go: expired access tokens go; used refresh tokens are kept a week to spot one being reused.
  for (const t of await ctx.store.find<TokenDoc>('oauthTokens', { keyId })) {
    if ((t.kind === 'access' && Date.parse(t.expiresAt) < Date.now()) || (t.usedAt && Date.now() - Date.parse(t.usedAt) > 7 * 86400_000)) await ctx.store.remove('oauthTokens', t._id);
  }
  const access = `ldo_at_${randomToken(32)}`, refresh = `ldo_rt_${randomToken(32)}`;
  const now = Date.now();
  const accessExp = new Date(Math.min(now + ACCESS_TTL_S * 1000, keyExpiresAt ? Date.parse(keyExpiresAt) : Infinity)).toISOString();
  const refreshExp = keyExpiresAt ?? new Date(now + 100 * 365 * 86400_000).toISOString();
  await ctx.store.insert<TokenDoc>('oauthTokens', { _id: newId('tok'), hash: sha256(access), kind: 'access', keyId, expiresAt: accessExp, usedAt: null });
  await ctx.store.insert<TokenDoc>('oauthTokens', { _id: newId('tok'), hash: sha256(refresh), kind: 'refresh', keyId, expiresAt: refreshExp, usedAt: null });
  return { access, refresh, expiresIn: Math.round((Date.parse(accessExp) - now) / 1000) };
}

/** Requests from other origins: discovery, registration and tokens carry no cookies, so any origin may call them. */
function cors(reply: FastifyReply) {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version, accept');
  reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
}

/** The consent request as the client sent it, checked. */
async function checkRequest(q: Record<string, unknown>) {
  const client = await ctx.store.get<ClientDoc>('oauthClients', String(q.client_id || ''));
  if (!client) throw new HttpError(400, 'invalid_client', 'This assistant isn’t registered with your Little Dipper. Start connecting again from the assistant.');
  const redirectUri = String(q.redirect_uri || '');
  if (!client.redirectUris.includes(redirectUri)) throw new HttpError(400, 'invalid_redirect', 'The assistant sent a return address it didn’t register. For your safety, nothing was sent back.');
  if (q.response_type !== 'code') throw new HttpError(400, 'unsupported_response_type', 'Only the authorization code flow is supported');
  if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(q.code_challenge || ''))) throw new HttpError(400, 'invalid_request', 'PKCE with S256 is required');
  const resource = q.resource ? String(q.resource) : null;
  if (resource && resource.replace(/\/$/, '') !== `${await base()}/api/mcp`) throw new HttpError(400, 'invalid_target', 'That isn’t this Little Dipper’s MCP address');
  return { client, redirectUri, challenge: String(q.code_challenge), state: q.state ? String(q.state) : null };
}

const withParams = (uri: string, params: Record<string, string | null>) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
};

export default async function oauthRoutes(app: FastifyInstance) {
  // Token and registration requests come as forms or JSON.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));

  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp', '/.well-known/oauth-authorization-server', '/oauth/register', '/oauth/token']) {
    app.options(path, async (_req, reply) => { cors(reply); return reply.code(204).send(); });
  }

  const resourceMeta = async (_req: FastifyRequest, reply: FastifyReply) => { cors(reply); return protectedResourceMeta(); };
  app.get('/.well-known/oauth-protected-resource', resourceMeta);
  app.get('/.well-known/oauth-protected-resource/api/mcp', resourceMeta);

  app.get('/.well-known/oauth-authorization-server', async (_req, reply) => {
    cors(reply);
    const b = await base();
    return {
      issuer: b, authorization_endpoint: `${b}/oauth/authorize`, token_endpoint: `${b}/oauth/token`, registration_endpoint: `${b}/oauth/register`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], scopes_supported: await allScopes(), service_documentation: `${b}/admin/reference/endpoints`,
    };
  });

  /** Dynamic client registration: public clients (no secret), PKCE required. */
  app.post('/oauth/register', async (req, reply) => {
    cors(reply);
    rateLimit(req, 'oauth-register', 20, 60 * 60_000);
    const b = (req.body || {}) as { client_name?: string; client_uri?: string; redirect_uris?: unknown };
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String) : [];
    if (!uris.length || uris.length > 10 || !uris.every(checkRedirect)) return oauthError(reply, 'invalid_redirect_uri', 'redirect_uris: one to ten https addresses (http only for localhost)');
    const name = String(b.client_name || 'An assistant').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'An assistant';
    const client: ClientDoc = { _id: newId('cli'), name, uri: b.client_uri ? String(b.client_uri).slice(0, 300) : null, redirectUris: uris, createdAt: new Date().toISOString() };
    await ctx.store.insert('oauthClients', client);
    reply.code(201);
    return {
      client_id: client._id, client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000), client_name: name, redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    };
  });

  /** For the consent page: who's asking, checked, and what the owner can choose from. Signed-in owner only. */
  app.get('/api/oauth/request', async (req) => {
    await requireSession(req);
    const { client } = await checkRequest(req.query as Record<string, unknown>);
    const domains = await listDomains();
    return {
      client: { name: client.name, uri: client.uri, verified: false, redirectHost: new URL((req.query as { redirect_uri: string }).redirect_uri).host },
      everyday: EVERYDAY.filter((k) => domains.some((d) => d.id === k)),
      lengths: Object.keys(LENGTHS),
    };
  });

  /** The owner's answer. Returns where to send the browser: back to the assistant with a code, or with access_denied. */
  app.post('/api/oauth/authorize', async (req) => {
    const p = await requireSession(req);
    const b = (req.body || {}) as Record<string, unknown> & { approve?: boolean; preset?: 'everyday' | 'everything' | 'custom'; kinds?: string[]; documents?: boolean; assistant?: unknown; length?: string };
    const { client, redirectUri, challenge, state } = await checkRequest(b);
    const iss = await base();
    if (!b.approve) {
      await audit({ actor: ownerActor(p.key._id), action: 'oauth.deny', resource: `oauthClients/${client._id}`, text: `You turned down ${client.name}'s request to connect`, tone: 'owner' });
      return { redirect: withParams(redirectUri, { error: 'access_denied', state, iss }) };
    }
    const assistant = checkAssistant(b.assistant) ?? { mode: 'suggest', secretFields: [] };
    const length = (b.length && b.length in LENGTHS ? b.length : '60d') as Length;
    const scopes = await scopesFor({ preset: b.preset ?? 'everyday', kinds: b.kinds, documents: b.documents }, assistant.mode);
    const code = `ldo_ac_${randomToken(32)}`;
    await ctx.store.insert<CodeDoc>('oauthCodes', {
      _id: newId('cod'), hash: sha256(code), clientId: client._id, redirectUri, challenge, scopes, assistant, length, ownerKeyId: p.key._id,
      expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(), usedAt: null,
    });
    return { redirect: withParams(redirectUri, { code, state, iss }) };
  });

  app.post('/oauth/token', async (req, reply) => {
    cors(reply);
    rateLimit(req, 'oauth-token', 120, 15 * 60_000);
    reply.header('cache-control', 'no-store');
    const b = (req.body || {}) as Record<string, string | undefined>;

    if (b.grant_type === 'authorization_code') {
      const c = await ctx.store.findOne<CodeDoc>('oauthCodes', { hash: sha256(String(b.code || '')) });
      if (!c || c.usedAt || Date.parse(c.expiresAt) < Date.now()) return oauthError(reply, 'invalid_grant', 'The code is invalid, used or expired');
      await ctx.store.update('oauthCodes', c._id, { usedAt: new Date().toISOString() });
      if (b.client_id !== c.clientId || b.redirect_uri !== c.redirectUri) return oauthError(reply, 'invalid_grant', 'client_id or redirect_uri doesn’t match the request');
      if (!b.code_verifier || pkce(b.code_verifier) !== c.challenge) return oauthError(reply, 'invalid_grant', 'PKCE verification failed');
      const client = await ctx.store.get<ClientDoc>('oauthClients', c.clientId);
      const { doc } = await issueKey({ kind: 'app', name: client?.name ?? 'An assistant', scopes: c.scopes, assistant: c.assistant, ttlSec: LENGTHS[c.length] || undefined });
      await ctx.store.update('apiKeys', doc._id, { oauth: { clientId: c.clientId } });
      const t = await issueTokens(doc._id, doc.expiresAt);
      const len = { hour: 'for an hour', day: 'for a day', '60d': 'for 60 days', forever: 'until you disconnect it' }[c.length];
      await audit({ actor: ownerActor(c.ownerKeyId), action: 'oauth.connect', resource: `apiKeys/${doc._id}`, text: `You connected ${doc.name} ${len}`, tone: 'owner', ip: req.ip });
      return { access_token: t.access, token_type: 'Bearer', expires_in: t.expiresIn, refresh_token: t.refresh, scope: c.scopes.join(' ') };
    }

    if (b.grant_type === 'refresh_token') {
      const t = await ctx.store.findOne<TokenDoc>('oauthTokens', { hash: sha256(String(b.refresh_token || '')) });
      const key = t?.kind === 'refresh' ? await ctx.store.get<ApiKeyDoc>('apiKeys', t.keyId) : null;
      if (!t || !key || key.revokedAt || Date.parse(t.expiresAt) < Date.now() || (key.expiresAt && Date.parse(key.expiresAt) < Date.now())) {
        return oauthError(reply, 'invalid_grant', 'This connection has ended. Reconnect from the assistant.');
      }
      if (b.client_id && key.oauth && b.client_id !== key.oauth.clientId) return oauthError(reply, 'invalid_grant', 'client_id doesn’t match');
      if (t.usedAt) {
        if (Date.now() - Date.parse(t.usedAt) > REFRESH_GRACE_MS) {
          // Someone used this refresh token after it was swapped: assume it was stolen and end the connection.
          await ctx.store.update('apiKeys', key._id, { revokedAt: new Date().toISOString() });
          await audit({ actor: systemActor, action: 'oauth.reuse', resource: `apiKeys/${key._id}`, text: `${key.name} was disconnected: an old sign-in token was used again, which can mean it was copied`, tone: 'system', ip: req.ip });
          return oauthError(reply, 'invalid_grant', 'This connection was ended for safety. Reconnect from the assistant.');
        }
      } else await ctx.store.update('oauthTokens', t._id, { usedAt: new Date().toISOString() });
      const n = await issueTokens(key._id, key.expiresAt);
      return { access_token: n.access, token_type: 'Bearer', expires_in: n.expiresIn, refresh_token: n.refresh, scope: key.scopes.join(' ') };
    }

    return oauthError(reply, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
  });
}
