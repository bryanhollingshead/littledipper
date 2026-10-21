import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { config } from '../config.js';
import { ctx } from '../ctx.js';
import { decrypt, encrypt, newId, normalizeRecoveryCode, recoveryCode, sha256 } from '../crypto.js';
import { audit, ownerActor, systemActor } from '../audit.js';
import {
  bad, COOKIE, cookieOpts, deviceLabel, findKey, HttpError, issueKey, rateLimit, requireSession, requireSetupOrSession, startSession,
} from '../auth.js';
import { canonicalUrl, getNode } from '../node.js';
import { getOwner, ownerFor, type OwnerDoc, type PasskeyRec } from '../owner.js';

/** WebAuthn binds to the hostname the browser is on; accept only our own addresses. */
async function rp(req: FastifyRequest) {
  const n = await getNode();
  const origin = String(req.headers.origin || canonicalUrl(n));
  let host: string;
  try { host = new URL(origin).hostname; } catch { throw bad('bad_origin'); }
  const known = [new URL(n.addresses.host).hostname, ...(n.addresses.domain ? [n.addresses.domain] : [])];
  const dev = config.devInsecurePeers && (host === 'localhost' || host === '127.0.0.1');
  if (!known.includes(host) && !dev) throw new HttpError(400, 'unknown_origin', `Passkeys work on ${known.join(' or ')}`);
  return { rpID: host, origin };
}

async function saveChallenge(challenge: string, purpose: string) {
  const id = newId('chl');
  await ctx.store.insert('challenges', { _id: id, challenge, purpose, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
  return id;
}
async function takeChallenge(id: string, purpose: string) {
  const c = await ctx.store.get('challenges', String(id || ''));
  if (!c || c.purpose !== purpose || new Date(c.expiresAt).getTime() < Date.now()) throw bad('challenge_expired', 'That took too long. Try again.');
  await ctx.store.remove('challenges', c._id);
  return c.challenge as string;
}

const needOwner = async (mode: 'setup' | 'session') => {
  const o = await ownerFor(mode);
  if (!o) throw bad('owner_missing', 'Add your name first');
  return o;
};

async function issueRecoveryCodes(o: OwnerDoc) {
  const codes = Array.from({ length: 8 }, recoveryCode);
  await ctx.store.update('owners', o._id, { recoveryCodeHashes: codes.map((c) => ({ hash: sha256(normalizeRecoveryCode(c)), usedAt: null })) });
  return codes;
}

export default async function authRoutes(app: FastifyInstance) {
  // Setup step "You": name + recovery email.
  app.post('/api/v1/owner', async (req) => {
    const mode = await requireSetupOrSession(req);
    if (mode !== 'setup') throw new HttpError(409, 'already_claimed', 'Use PATCH /api/v1/owner');
    const { displayName, email } = (req.body || {}) as { displayName?: string; email?: string };
    const name = String(displayName || '').trim();
    const mail = String(email || '').trim();
    if (!name) throw bad('name_required', 'Add your name');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw bad('email_invalid', 'Enter a valid email');
    const existing = await ownerFor('setup');
    if (existing) {
      await ctx.store.update('owners', existing._id, { displayName: name, email: mail });
      return { id: existing._id, displayName: name, email: mail };
    }
    const o: OwnerDoc = {
      _id: newId('own'), displayName: name, email: mail, pending: true, passkeys: [], passwordHash: null,
      totp: { enabled: false, secretEnc: null }, recoveryCodeHashes: [], prefs: { showTechnical: false }, createdAt: new Date().toISOString(),
    };
    await ctx.store.insert('owners', o);
    return { id: o._id, displayName: name, email: mail };
  });

  // ── passkey registration (setup or signed-in owner) ──────────────────
  app.post('/api/v1/auth/passkeys/register/options', async (req) => {
    const mode = await requireSetupOrSession(req);
    const o = await needOwner(mode);
    const { rpID } = await rp(req);
    const opts = await generateRegistrationOptions({
      rpName: 'Little Dipper', rpID, userName: o.email, userDisplayName: o.displayName,
      userID: new TextEncoder().encode(o._id), attestationType: 'none',
      excludeCredentials: o.passkeys.map((p) => ({ id: p.credentialId, transports: p.transports as never })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    return { challengeId: await saveChallenge(opts.challenge, 'register'), options: opts };
  });

  app.post('/api/v1/auth/passkeys/register', async (req) => {
    const mode = await requireSetupOrSession(req);
    const o = await needOwner(mode);
    const { challengeId, response, label } = (req.body || {}) as { challengeId: string; response: never; label?: string };
    const expectedChallenge = await takeChallenge(challengeId, 'register');
    const { rpID, origin } = await rp(req);
    const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false })
      .catch((e) => { throw bad('passkey_failed', e.message); });
    if (!v.verified || !v.registrationInfo) throw bad('passkey_failed', "Your device didn't confirm the passkey");
    const c = v.registrationInfo.credential;
    const rec: PasskeyRec = {
      credentialId: c.id, publicKey: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter, transports: c.transports,
      label: label || deviceLabel(req), createdAt: new Date().toISOString(), lastUsedAt: null,
    };
    await ctx.store.update('owners', o._id, { passkeys: [...o.passkeys, rec] });
    if (mode === 'session') await audit({ actor: { type: 'owner', id: o._id }, action: 'auth.passkey.add', resource: 'owners', text: `You added a passkey (${rec.label})`, tone: 'owner' });
    return { credentialId: rec.credentialId, label: rec.label };
  });

  app.get('/api/v1/auth/passkeys', async (req) => {
    await requireSession(req);
    const o = await getOwner();
    return { items: (o?.passkeys || []).map((p) => ({ id: p.credentialId, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })) };
  });

  app.delete('/api/v1/auth/passkeys/:id', async (req) => {
    const p = await requireSession(req);
    const o = (await getOwner())!;
    const { id } = req.params as { id: string };
    if (o.passkeys.length <= 1 && !(o.passwordHash && o.totp.enabled)) throw bad('last_passkey', "This is your only way to sign in. Add another passkey or set up a password first.");
    const pk = o.passkeys.find((x) => x.credentialId === id);
    await ctx.store.update('owners', o._id, { passkeys: o.passkeys.filter((x) => x.credentialId !== id) });
    await audit({ actor: ownerActor(p.key._id), action: 'auth.passkey.remove', resource: 'owners', text: `You removed a passkey (${pk?.label || 'unknown'})`, tone: 'owner' });
    return { removed: true };
  });

  // ── passkey sign-in ──────────────────────────────────────────────────
  app.post('/api/v1/auth/passkeys/options', async (req) => {
    rateLimit(req, 'signin', 30, 15 * 60_000);
    const o = await getOwner();
    const { rpID } = await rp(req);
    const opts = await generateAuthenticationOptions({
      rpID, userVerification: 'preferred',
      allowCredentials: (o?.passkeys || []).map((p) => ({ id: p.credentialId, transports: p.transports as never })),
    });
    return { challengeId: await saveChallenge(opts.challenge, 'login'), options: opts };
  });

  app.post('/api/v1/auth/passkeys/verify', async (req, reply) => {
    rateLimit(req, 'signin', 30, 15 * 60_000);
    const { challengeId, response } = (req.body || {}) as { challengeId: string; response: { id: string } };
    const expectedChallenge = await takeChallenge(challengeId, 'login');
    const o = await getOwner();
    const pk = o?.passkeys.find((p) => p.credentialId === response?.id);
    if (!o || !pk) throw new HttpError(401, 'unknown_passkey', "That passkey isn't registered here");
    const { rpID, origin } = await rp(req);
    const v = await verifyAuthenticationResponse({
      response: response as never, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
      credential: { id: pk.credentialId, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports as never },
    }).catch(() => ({ verified: false, authenticationInfo: { newCounter: 0 } }));
    if (!v.verified) throw new HttpError(401, 'passkey_failed', "Your passkey couldn't be verified");
    await ctx.store.update('owners', o._id, { passkeys: o.passkeys.map((p) => (p === pk ? { ...p, counter: v.authenticationInfo.newCounter, lastUsedAt: new Date().toISOString() } : p)) });
    await startSession(reply, deviceLabel(req));
    await audit({ actor: systemActor, action: 'auth.signin', resource: 'owners', text: `Signed in with a passkey (${pk.label})`, tone: 'system', ip: req.ip });
    return { session: true, scopes: ['admin:*'] };
  });

  // ── fallback: password + authenticator code ──────────────────────────
  app.put('/api/v1/auth/password', async (req) => {
    const p = await requireSession(req);
    const { password } = (req.body || {}) as { password?: string };
    if (!password || password.length < 12) throw bad('weak_password', 'Use at least 12 characters');
    const o = (await getOwner())!;
    await ctx.store.update('owners', o._id, { passwordHash: await argonHash(password) });
    await audit({ actor: ownerActor(p.key._id), action: 'auth.password.set', resource: 'owners', text: 'You set a fallback password', tone: 'owner' });
    return { ok: true };
  });

  app.post('/api/v1/auth/totp/setup', async (req) => {
    await requireSession(req);
    const o = (await getOwner())!;
    const secret = authenticator.generateSecret();
    await ctx.store.update('owners', o._id, { totp: { ...o.totp, pendingSecretEnc: encrypt(ctx.keys.masterKey, secret) } });
    const n = await getNode();
    return { secret, otpauth: authenticator.keyuri(o.email, `Little Dipper (${new URL(canonicalUrl(n)).host})`, secret) };
  });

  app.post('/api/v1/auth/totp/enable', async (req) => {
    const p = await requireSession(req);
    const o = (await getOwner())!;
    const { code } = (req.body || {}) as { code?: string };
    if (!o.totp.pendingSecretEnc) throw bad('no_pending_totp');
    const secret = decrypt(ctx.keys.masterKey, o.totp.pendingSecretEnc);
    if (!authenticator.verify({ token: String(code || '').replace(/\s/g, ''), secret })) throw bad('bad_code', "That code didn't match. Check your authenticator app's clock.");
    await ctx.store.update('owners', o._id, { totp: { enabled: true, secretEnc: o.totp.pendingSecretEnc, pendingSecretEnc: null } });
    await audit({ actor: ownerActor(p.key._id), action: 'auth.totp.enable', resource: 'owners', text: 'You turned on authenticator codes', tone: 'owner' });
    return { enabled: true };
  });

  app.post('/api/v1/auth/fallback/disable', async (req) => {
    const p = await requireSession(req);
    const o = (await getOwner())!;
    await ctx.store.update('owners', o._id, { passwordHash: null, totp: { enabled: false, secretEnc: null, pendingSecretEnc: null } });
    await audit({ actor: ownerActor(p.key._id), action: 'auth.fallback.disable', resource: 'owners', text: 'You turned off password sign-in', tone: 'owner' });
    return { ok: true };
  });

  app.post('/api/v1/auth/password', async (req, reply) => {
    rateLimit(req, 'signin', 30, 15 * 60_000);
    const { password } = (req.body || {}) as { password?: string };
    const o = await getOwner();
    if (!o?.passwordHash || !o.totp.enabled) throw bad('fallback_off', "Password sign-in isn't set up for this Little Dipper");
    if (!(await argonVerify(o.passwordHash, String(password || '')))) throw new HttpError(401, 'bad_password', "That password isn't right");
    const { secret } = await issueKey({ kind: 'mfa', name: 'Password step', scopes: ['mfa'], ttlSec: 300 });
    reply.setCookie(COOKIE.mfa, secret, cookieOpts(300));
    return { next: 'totp' };
  });

  app.post('/api/v1/auth/totp/verify', async (req, reply) => {
    rateLimit(req, 'signin', 30, 15 * 60_000);
    const mfa = await findKey(req.cookies[COOKIE.mfa], ['mfa']);
    if (!mfa) throw new HttpError(401, 'password_first', 'Enter your password first');
    const o = (await getOwner())!;
    const { code } = (req.body || {}) as { code?: string };
    const secret = o.totp.secretEnc ? decrypt(ctx.keys.masterKey, o.totp.secretEnc) : '';
    if (!secret || !authenticator.verify({ token: String(code || '').replace(/\s/g, ''), secret })) throw new HttpError(401, 'bad_code', "That code didn't match");
    await ctx.store.update('apiKeys', mfa._id, { revokedAt: new Date().toISOString() });
    reply.clearCookie(COOKIE.mfa, { path: '/' });
    await startSession(reply, deviceLabel(req));
    await audit({ actor: systemActor, action: 'auth.signin', resource: 'owners', text: 'Signed in with password and authenticator code', tone: 'system', ip: req.ip });
    return { session: true, scopes: ['admin:*'] };
  });

  // ── recovery codes ───────────────────────────────────────────────────
  app.post('/api/v1/auth/recovery-codes', async (req) => {
    const mode = await requireSetupOrSession(req);
    const o = await needOwner(mode);
    const codes = await issueRecoveryCodes(o);
    if (mode === 'session') await audit({ actor: { type: 'owner', id: o._id }, action: 'auth.recovery.regenerate', resource: 'owners', text: 'You regenerated your recovery codes', tone: 'owner' });
    return { codes };
  });

  app.post('/api/v1/auth/recovery', async (req, reply) => {
    rateLimit(req, 'recovery', 10, 15 * 60_000);
    const { code } = (req.body || {}) as { code?: string };
    const o = await getOwner();
    const h = sha256(normalizeRecoveryCode(String(code || '')));
    const hit = o?.recoveryCodeHashes.find((r) => r.hash === h && !r.usedAt);
    if (!o || !hit) throw new HttpError(401, 'bad_recovery_code', "That recovery code isn't valid or was already used");
    await ctx.store.update('owners', o._id, { recoveryCodeHashes: o.recoveryCodeHashes.map((r) => (r === hit ? { ...r, usedAt: new Date().toISOString() } : r)) });
    await startSession(reply, deviceLabel(req));
    const left = o.recoveryCodeHashes.filter((r) => !r.usedAt).length - 1;
    await audit({ actor: systemActor, action: 'auth.signin', resource: 'owners', text: `Signed in with a recovery code · ${left} left`, tone: 'system', ip: req.ip });
    return { session: true, codesLeft: left };
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const k = await findKey(req.cookies[COOKIE.session], ['session']);
    if (k) await ctx.store.update('apiKeys', k._id, { revokedAt: new Date().toISOString() });
    reply.clearCookie(COOKIE.session, { path: '/' });
    return { ok: true };
  });

  app.get('/api/v1/auth/security', async (req) => {
    await requireSession(req);
    const o = (await getOwner())!;
    return {
      passkeys: o.passkeys.map((p) => ({ id: p.credentialId, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt })),
      password: !!o.passwordHash, totp: o.totp.enabled,
      recoveryCodes: { total: o.recoveryCodeHashes.length, unused: o.recoveryCodeHashes.filter((r) => !r.usedAt).length },
    };
  });
}
