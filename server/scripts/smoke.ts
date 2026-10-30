/**
 * End-to-end smoke test: two Little Dippers on localhost, claimed with a software
 * passkey, then connected through an invite link, sharing fields both ways.
 *
 *   npx tsx scripts/smoke.ts            (starts two servers on 4201/4202 in a temp dir)
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// ── minimal CBOR encoder (ints, bytes, text, maps) ──────────────────────
function cborHead(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
function cbor(v: unknown): Buffer {
  if (typeof v === 'number') return v >= 0 ? cborHead(0, v) : cborHead(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([cborHead(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([cborHead(3, b.length), b]); }
  if (v instanceof Map) return Buffer.concat([cborHead(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}
const b64u = (b: Buffer) => b.toString('base64url');

/** A software authenticator: one P-256 credential. */
class SoftKey {
  key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  id = crypto.randomBytes(16);
  counter = 0;
  register(opts: { challenge: string; rp: { id: string } }, origin: string) {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    const cnt = Buffer.alloc(4);
    const len = Buffer.alloc(2); len.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([crypto.createHash('sha256').update(opts.rp.id).digest(), Buffer.from([0x45]), cnt, Buffer.alloc(16), len, this.id, cose]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: opts.challenge, origin, crossOrigin: false }));
    const att = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return { id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', response: { clientDataJSON: b64u(clientData), attestationObject: b64u(att), transports: ['internal'] }, clientExtensionResults: {} };
  }
  assert(opts: { challenge: string; rpId: string }, origin: string) {
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([crypto.createHash('sha256').update(opts.rpId).digest(), Buffer.from([0x05]), cnt]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opts.challenge, origin, crossOrigin: false }));
    const sig = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]), this.key.privateKey);
    return { id: b64u(this.id), rawId: b64u(this.id), type: 'public-key', response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) }, clientExtensionResults: {} };
  }
}

// ── tiny client with a cookie jar ───────────────────────────────────────
class Client {
  jar = new Map<string, string>();
  constructor(public base: string) {}
  async call<T = any>(method: string, p: string, body?: unknown, expect = [200, 201, 202]): Promise<T> {
    const res = await fetch(this.base + p, {
      method,
      headers: { origin: this.base, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const [k, v] = kv.split('=');
      if (v) this.jar.set(k, v); else this.jar.delete(k);
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!expect.includes(res.status)) throw new Error(`${method} ${p} → ${res.status} ${text}`);
    return data;
  }
}

function startNode(port: number, dir: string, extra: Record<string, string> = {}): Promise<{ proc: ChildProcess; claimUrl: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', 'src/server.ts'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), LD_DATA_DIR: dir, LOG_LEVEL: 'warn', LD_PUBLIC_URL: `http://localhost:${port}`, LD_RETRY_BASE_MS: '300', ...extra } });
    let claimUrl = '';
    proc.stdout!.on('data', (d: Buffer) => {
      const s = d.toString();
      const m = s.match(/Claim this node: (\S+)/);
      if (m) claimUrl = m[1];
      if (s.includes('Answering at')) resolve({ proc, claimUrl });
    });
    proc.stderr!.on('data', (d: Buffer) => process.stderr.write(d));
    proc.on('exit', (code) => reject(new Error(`server ${port} exited ${code}`)));
  });
}

async function claim(c: Client, claimUrl: string, name: string, key: SoftKey) {
  await c.call('POST', '/api/v1/node/claim', { token: new URL(claimUrl).searchParams.get('token') });
  await c.call('POST', '/api/v1/owner', { displayName: name, email: `${name.split(' ')[0].toLowerCase()}@example.com` });
  const reg = await c.call('POST', '/api/v1/auth/passkeys/register/options', {});
  await c.call('POST', '/api/v1/auth/passkeys/register', { challengeId: reg.challengeId, response: key.register(reg.options, c.base), label: 'Soft key' });
  const { codes } = await c.call('POST', '/api/v1/auth/recovery-codes', {});
  await c.call('POST', '/api/v1/node/claim/complete', {});
  return codes as string[];
}

const ok = (cond: unknown, msg: string) => { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ✓ ' + msg); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run the little-dipper CLI against a data directory; returns stdout, or throws with stderr. */
function cli(dir: string, args: string[], input = '') {
  return execFileSync('npx', ['tsx', 'src/cli.ts', ...args], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, LD_DATA_DIR: dir }, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Turn a stopped node's SQLite database back into the JSON store.json nodes had before SQLite. */
function toJsonStore(dir: string) {
  const file = path.join(dir, 'little-dipper.db');
  const db = new Database(file);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  const data = Object.fromEntries(tables.map((t) => [t, Object.fromEntries((db.prepare(`SELECT _id, doc FROM "${t}"`).all() as { _id: string; doc: string }[]).map((r) => [r._id, JSON.parse(r.doc)]))]));
  db.close();
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (existsSync(f)) unlinkSync(f);
  writeFileSync(path.join(dir, 'store.json'), JSON.stringify(data));
  return Object.values(data).reduce((n, docs) => n + Object.keys(docs).length, 0);
}

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ld-smoke-'));
  const [A, firstB] = await Promise.all([startNode(4201, path.join(tmp, 'a'), { LD_BIG_DIPPER_URL: 'http://localhost:4202' }), startNode(4202, path.join(tmp, 'b'))]);
  let B = firstB; // restarted mid-test to check offline delivery
  const a = new Client('http://localhost:4201'), b = new Client('http://localhost:4202');
  const ka = new SoftKey(), kb = new SoftKey();
  try {
    console.log('claim');
    const codesA = await claim(a, A.claimUrl, 'Maya Lindqvist', ka);
    await claim(b, B.claimUrl, 'Theo Nakamura', kb);
    ok((await a.call('GET', '/api/v1/node/status')).claimed, 'A is claimed');
    await a.call('POST', '/api/v1/node/claim', { token: new URL(A.claimUrl).searchParams.get('token') }, [401]);
    ok(true, 'claim link no longer works');

    console.log('sign-in');
    await a.call('POST', '/api/v1/auth/logout', {});
    await a.call('GET', '/api/v1/owner', undefined, [401]);
    const lo = await a.call('POST', '/api/v1/auth/passkeys/options', {});
    await a.call('POST', '/api/v1/auth/passkeys/verify', { challengeId: lo.challengeId, response: ka.assert(lo.options, a.base) });
    ok((await a.call('GET', '/api/v1/owner')).displayName === 'Maya Lindqvist', 'passkey sign-in works');
    const r = new Client(a.base);
    ok((await r.call('POST', '/api/v1/auth/recovery', { code: codesA[0].toLowerCase() })).codesLeft === 7, 'recovery code sign-in works');
    await new Client(a.base).call('POST', '/api/v1/auth/recovery', { code: codesA[0] }, [401]);
    ok(true, 'used recovery code is rejected');

    console.log('my data');
    await a.call('POST', '/api/v1/data/contact_methods', { data: { kind: 'phone', label: 'Mobile', value: '+1 (503) 555-0148', primary: true } });
    await a.call('POST', '/api/v1/data/residences', { data: { street1: '2214 SE Ankeny St', city: 'Portland', region: 'OR', postalCode: '97214', country: 'us', ownership: 'rent' }, validFrom: '2019-06' });
    const ssn = await a.call('POST', '/api/v1/owner/fields', { label: 'Passport number', value: 'X1234567', sensitivity: 'secret', section: 'gov' });
    const fields = (await a.call('GET', '/api/v1/owner/fields')).items;
    ok(fields.find((f: any) => f.key === ssn.key).value.startsWith('••••'), 'secret value is masked');
    ok((await a.call('POST', `/api/v1/owner/fields/${ssn.key}/reveal`, {})).value === 'X1234567', 'reveal returns value');
    await a.call('PUT', '/api/v1/public-profile', { fieldKeys: [ssn.key] }, [400]);
    ok(true, 'secret field cannot be public');
    await a.call('PUT', '/api/v1/public-profile', { headline: 'Ceramicist in Portland', fieldKeys: ['preferred_name', 'email'] });
    const pub = await new Client(a.base).call('GET', '/public/v1/profile');
    ok(pub.fields.length === 2 && pub.headline.startsWith('Ceramicist'), 'public profile shows chosen fields');

    console.log('connections');
    await a.call('POST', '/api/v1/federation/requests', { address: 'localhost:4202' }, [403]);
    ok(true, 'stranger request refused while B has connect requests off');
    const inv = await b.call('POST', '/api/v1/federation/invites', { expiresIn: '7d' });
    const look = await a.call('POST', '/api/v1/federation/lookup', { address: inv.url });
    ok(look.displayName === 'Theo Nakamura' && look.viaInvite, 'lookup via invite link finds Theo');
    const sent = await a.call('POST', '/api/v1/federation/requests', { address: inv.url, offeredFields: ['address'], note: 'Hi Theo' });
    ok(sent.delivered, 'request delivered');
    const inB = (await b.call('GET', '/api/v1/federation/requests?status=pending&direction=in')).items;
    ok(inB.length === 1 && !inB[0].quiet && inB[0].inviteId, 'B sees a (non-quiet) invite request');
    await a.call('POST', '/api/v1/federation/requests', { address: inv.url }, [409]);
    const reuse = await new Client(b.base).call('GET', `/public/v1/invites/${inv.url.split('invite=')[1]}`);
    ok(!reuse.valid, 'invite is single use');

    const acc = await b.call('POST', `/api/v1/federation/requests/${inB[0]._id}/accept`, {});
    ok(acc.status === 'active', 'B accepted');
    await sleep(700);
    const cA = (await a.call('GET', '/api/v1/contacts')).items[0];
    ok(cA.status === 'active', 'A sees the connection as active');
    const detA = await a.call('GET', `/api/v1/contacts/${cA.id}?sync=1`);
    ok(detA.sharedIn.some((f: any) => f.key === 'preferred_name' && f.value === 'Theo'), "A reads Theo's basic profile");
    const cB = (await b.call('GET', '/api/v1/contacts')).items[0];
    let detB = await b.call('GET', `/api/v1/contacts/${cB.id}?sync=1`);
    ok(detB.sharedIn.some((f: any) => f.key === 'address'), 'B reads the sensitive field A offered');
    ok(!detB.sharedIn.some((f: any) => f.key === ssn.key), "B can't read A's secret field");

    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { fields: { [ssn.key]: true } }, [409]);
    ok(true, 'secret grant needs confirm');
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { fields: { [ssn.key]: true }, confirm: true });
    detB = await b.call('GET', `/api/v1/contacts/${cB.id}?sync=1`);
    ok(detB.sharedIn.some((f: any) => f.key === ssn.key && f.value === 'X1234567'), 'B reads the secret after confirmed grant');
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { profile: false, fields: { [ssn.key]: false, address: false } });
    detB = await b.call('GET', `/api/v1/contacts/${cB.id}?sync=1`);
    ok(detB.sharedIn.length === 0, 'turning sharing off removes it on the next read');
    const audit = (await a.call('GET', '/api/v1/audit?limit=50')).items;
    ok(audit.some((e: any) => e.action === 'field.read'), "A's audit log records B's reads");

    const rot = await a.call('POST', `/api/v1/federation/links/${detA.node.linkId}/rotate`, {});
    ok(rot.rotated, 'connection refreshed (tokens rotated)');
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { profile: true });
    detB = await b.call('GET', `/api/v1/contacts/${cB.id}?sync=1`);
    ok(detB.sharedIn.length > 0 && !detB.syncError, 'reads still work after rotation');

    console.log('domains');
    const cat = (await a.call('GET', '/api/v1/catalog')).domains;
    ok(cat.length >= 20 && cat.some((d: any) => d.id === 'employment' && d.endpoint === '/api/v1/data/employment'), `catalog lists ${cat.length} domains`);
    ok((await a.call('GET', '/api/v1/residences')).items.length === (await a.call('GET', '/api/v1/data/residences')).items.length, 'old /api/v1/{domain} path still answers until beta');
    await a.call('GET', '/api/v1/data/messages', undefined, [404]);
    ok(true, 'fixed routes are not domains under /data');
    // Residences feed the derived profile fields
    const res = (await a.call('GET', '/api/v1/data/residences')).items[0];
    await a.call('POST', '/api/v1/data/residences', { data: { street1: '12 Kungsgatan', city: 'Stockholm', country: 'SE' }, validFrom: '2012-01', validTo: '2019-05' });
    let prof = (await a.call('GET', '/api/v1/owner/fields')).items;
    ok(prof.find((f: any) => f.key === 'address').value.startsWith('2214 SE Ankeny St, Portland, OR 97214') && prof.find((f: any) => f.key === 'country_res').value === 'United States', 'current residence feeds Current address + Country of residence');
    await a.call('PUT', '/api/v1/owner/fields/address', { value: 'elsewhere' }, [409]);
    ok(true, 'derived field refuses direct edits');
    const cur = (await a.call('GET', '/api/v1/data/residences?current=true')).items;
    ok(cur.length === 1 && cur[0].id === res.id && cur[0].title === '2214 SE Ankeny St, Portland', 'current=true returns the current residence');
    await a.call('POST', '/api/v1/data/residences', { data: { street1: 'x' } }, [400]);
    await a.call('POST', '/api/v1/data/residences', { data: { street1: 'x', city: 'y', country: 'US', nope: 1 } }, [400]);
    await a.call('POST', '/api/v1/data/residences', { data: { street1: 'x', city: 'y', country: 'US' }, validFrom: '2020-01', validTo: '2019-01' }, [400]);
    await a.call('POST', '/api/v1/data/financial_accounts', { data: { kind: 'checking', institution: 'Harbor CU', last4: '4111111111111111' } }, [400]);
    ok(true, 'validation: required parts, unknown parts, date order, last-4 only');
    // Employment with secret pay
    const job = await a.call('POST', '/api/v1/data/employment', { data: { employer: 'Alder Studio', title: 'Product designer', city: 'Portland', country: 'US', currentPay: { amount: 120000, currency: 'usd' }, employeeId: 'AS-0042' }, validFrom: '2021-03' });
    await a.call('POST', '/api/v1/data/employment', { data: { employer: 'Kiln Co', title: 'Ceramicist' }, validFrom: '2016-01', validTo: '2021-02' });
    ok(job.title === 'Product designer at Alder Studio' && job.masked.includes('currentPay') && job.data.employeeId.startsWith('••••'), 'secret parts are masked');
    const rev = await a.call('POST', `/api/v1/data/employment/${job.id}/reveal`, {});
    ok(rev.data.currentPay.amount === 120000 && rev.data.employeeId === 'AS-0042', 'reveal decrypts secret parts');
    const upd = await a.call('PATCH', `/api/v1/data/employment/${job.id}`, { data: { title: 'Design lead', department: 'Product' } });
    const rev2 = await a.call('POST', `/api/v1/data/employment/${job.id}/reveal`, {});
    ok(upd.title === 'Design lead at Alder Studio' && rev2.data.employeeId === 'AS-0042', 'patch keeps untouched secret parts');
    await a.call('POST', '/api/v1/data/ids', { data: { kind: 'passport', number: 'P1234567', issuer: 'US', expires: '2031-04' } });
    const tl = (await a.call('GET', '/api/v1/timeline')).items;
    ok(tl.length >= 4 && tl[0].validFrom >= tl[tl.length - 1].validFrom, `timeline merges ${tl.length} dated records`);
    // Custom domain
    const wine = await a.call('POST', '/api/v1/catalog', { label: 'Wine cellar', parts: [{ label: 'Wine', type: 'text', required: true }, { label: 'Vintage', type: 'number' }], dated: false });
    await a.call('POST', `/api/v1/data/${wine.id}`, { data: { Wine: 'Willamette Pinot', Vintage: 2018 } });
    ok(wine.id === 'x_wine_cellar' && (await a.call('GET', `/api/v1/data/${wine.id}`)).items.length === 1, 'custom category works like a built-in one');
    const appts = await a.call('POST', '/api/v1/catalog', { label: 'Appointments', parts: [{ label: 'What', type: 'text', required: true }, { label: 'When', type: 'datetime', required: true }], dated: false });
    const appt = await a.call('POST', `/api/v1/data/${appts.id}`, { data: { What: 'Dentist', When: { at: '2026-11-04T09:30', tz: 'America/New_York' } } });
    ok(appt.data.When.at === '2026-11-04T09:30:00-05:00' && appt.data.When.tz === 'America/New_York', 'a datetime given as wall-clock time is stored with its offset');
    const summer = await a.call('POST', `/api/v1/data/${appts.id}`, { data: { What: 'Picnic', When: { at: '2026-07-04T16:00:00Z', tz: 'America/New_York' } } });
    ok(summer.data.When.at === '2026-07-04T12:00:00-04:00', 'a UTC datetime is re-expressed in its zone, daylight saving included');
    const badZone = await fetch(`${a.base}/api/v1/data/${appts.id}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: a.base, cookie: [...a.jar].map(([k, v]) => `${k}=${v}`).join('; ') }, body: JSON.stringify({ data: { What: 'x', When: { at: '2026-11-04T09:30', tz: 'Mars/Olympus' } } }) });
    ok(badZone.status === 400 && (await badZone.json()).code === 'invalid_value', 'an unknown time zone is refused with a clear code');
    const apptList = (await a.call('GET', `/api/v1/data/${appts.id}`)).items;
    ok(apptList.length === 2 && apptList.some((r: any) => r.title.includes('Dentist')), 'datetime records list and read back');
    // Scoped app key
    const emp = await a.call('POST', '/api/v1/keys', { name: 'Resume builder', scopes: ['employment:read'] });
    const auth = { headers: { authorization: `Bearer ${emp.secret}` } };
    ok((await fetch(a.base + '/api/v1/data/employment', auth)).status === 200 && (await fetch(a.base + '/api/v1/data/ids', auth)).status === 403, 'employment:read key reads jobs but not IDs');
    // Sharing a domain with a connection
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { domains: { employment: { scope: 'current' } } });
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { domains: { ids: true } }, [409]);
    ok(true, 'secret domain needs confirmation');
    detB = await b.call('GET', `/api/v1/contacts/${cB.id}?sync=1`);
    const sharedJobs = detB.sharedDomains.find((d: any) => d.domain === 'employment');
    ok(sharedJobs && sharedJobs.records.length === 1 && sharedJobs.records[0].title === 'Design lead at Alder Studio', 'B sees only the current job');
    ok(!sharedJobs.records[0].fields.some((f: any) => f.key === 'currentPay' || f.key === 'employeeId'), 'secret parts are not shared');
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { domains: { employment: { scope: 'all', includeSecret: true } }, confirm: true });
    detB = await b.call('GET', `/api/v1/contacts/${cB.id}?sync=1`);
    const jobs2 = detB.sharedDomains.find((d: any) => d.domain === 'employment');
    ok(jobs2.records.length === 2 && jobs2.records[0].fields.some((f: any) => f.key === 'currentPay'), 'scope all + confirmed secrets');
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { domains: { employment: false } });
    detB = await b.call('GET', `/api/v1/contacts/${cB.id}?sync=1`);
    ok(!detB.sharedDomains.length, 'unsharing removes it');
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { domains: { education: true } });
    await a.call('POST', '/api/v1/data/education', { data: { institution: 'Konstfack', degree: 'MFA' }, validFrom: '2012-09', validTo: '2014-06' });
    await sleep(3000);
    detB = await b.call('GET', `/api/v1/contacts/${cB.id}`);
    ok(detB.sharedDomains.some((d: any) => d.domain === 'education' && d.records.length === 1), 'grant + edit nudge B to sync without asking');
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { domains: { education: false } });
    console.log('receipts & documents');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const cookieOf = (c: Client) => [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const asOwner = () => ({ cookie: cookieOf(a) });
    const raw = (method: string, p: string, bytes: Buffer, type: string, headers: Record<string, string> = asOwner()) =>
      fetch(a.base + p, { method, headers: { origin: a.base, 'content-type': type, ...headers }, body: bytes });
    const json = async (r: Response) => ({ status: r.status, body: await r.json() });
    // Upload into the inbox
    const up = await json(await raw('POST', '/api/v1/documents?name=license-front.png', png, 'image/png'));
    ok(up.status === 201 && up.body.status === 'inbox' && up.body.title === 'license-front' && up.body.pages.length === 1, 'upload lands in the documents inbox');
    ok((await raw('POST', '/api/v1/documents?name=x.png', Buffer.from('not really a png'), 'image/png')).status === 400, 'contents must match the declared type');
    ok((await raw('POST', '/api/v1/documents?name=x.txt', Buffer.from('hello'), 'text/plain')).status === 415, 'only photos and PDFs are accepted');
    const twoPages = await json(await raw('POST', `/api/v1/documents/${up.body.id}/pages?name=license-back.png`, png, 'image/png'));
    ok(twoPages.body.pages.length === 2, 'a second page (the back of the card)');
    const got = await fetch(`${a.base}/api/v1/files/${up.body.pages[0].id}`, { headers: asOwner() });
    ok(got.status === 200 && got.headers.get('content-type') === 'image/png' && Buffer.from(await got.arrayBuffer()).equals(png), 'a page comes back byte for byte');
    // An assistant reads it and suggests an entry; the owner accepts
    const helper = await a.call('POST', '/api/v1/keys', { name: 'Document reader', scopes: ['documents:read', 'documents:write'] });
    const asHelper = { authorization: `Bearer ${helper.secret}` };
    const inbox = await (await fetch(`${a.base}/api/v1/documents?status=inbox`, { headers: asHelper })).json();
    ok(inbox.items.some((d: any) => d.id === up.body.id), 'an assistant key finds new documents in the inbox');
    const bad = await fetch(`${a.base}/api/v1/documents/${up.body.id}/suggestions`, { method: 'POST', headers: { ...asHelper, 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'ids', data: { kind: 'drivers_license', number: 'WDL123', expires: 'soon' } }) });
    ok(bad.status === 400, 'a suggestion with invalid values is refused up front');
    const sug = await (await fetch(`${a.base}/api/v1/documents/${up.body.id}/suggestions`, { method: 'POST', headers: { ...asHelper, 'content-type': 'application/json' }, body: JSON.stringify({ domain: 'ids', data: { kind: 'drivers_license', number: 'WDL123', issuer: 'US', authority: 'WA', expires: '2030-05-01' }, note: 'Washington license, front and back' }) })).json();
    ok(sug.suggestions.length === 1 && sug.status === 'inbox', 'the assistant leaves a suggestion; nothing is changed yet');
    const self = await fetch(`${a.base}/api/v1/documents/${up.body.id}/suggestions/${sug.suggestions[0].id}/accept`, { method: 'POST', headers: { ...asHelper, 'content-type': 'application/json' }, body: '{}' });
    ok(self.status === 403, "an assistant can't accept its own suggestion");
    await fetch(`${a.base}/api/v1/documents/${up.body.id}`, { method: 'PATCH', headers: { ...asHelper, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'WASHINGTON DRIVER LICENSE WDL123' }) });
    ok((await a.call('GET', '/api/v1/documents?q=wdl123')).items.length === 1, 'text read by the assistant makes the document searchable');
    const accepted = await a.call('POST', `/api/v1/documents/${up.body.id}/suggestions/${sug.suggestions[0].id}/accept`, {});
    ok(accepted.record.domain === 'ids' && accepted.record.source.type === 'app' && accepted.document.status === 'filed' && accepted.document.links[0].recordId === accepted.record.id && !accepted.document.suggestions.length, 'owner accepts: the ID entry is created, linked and the document filed');
    const idsList = (await a.call('GET', '/api/v1/data/ids')).items;
    ok(idsList.find((r: any) => r.id === accepted.record.id).documents[0].pages.length === 2, 'the ID entry shows its card scan (front and back)');
    // Scopes follow links
    const emp2 = await a.call('POST', '/api/v1/keys', { name: 'Jobs only', scopes: ['employment:read'] });
    ok((await fetch(`${a.base}/api/v1/files/${up.body.pages[0].id}`, { headers: { authorization: `Bearer ${emp2.secret}` } })).status === 403, "a key for another category can't open the scan");
    // Share link for someone without a Little Dipper
    const share = await a.call('POST', `/api/v1/documents/${up.body.id}/shares`, { hours: 24 });
    const token = share.url.split('/s/')[1];
    const viewed = await (await fetch(`${a.base}/public/v1/shared/${token}`)).json();
    ok(viewed.title === 'license-front' && viewed.pages.length === 2 && viewed.sharedBy === 'Maya Lindqvist', 'a share link opens without signing in');
    ok((await fetch(`${a.base}/public/v1/shared/${token}/files/${viewed.pages[1].id}`)).status === 200, 'pages load through the share link');
    ok((await fetch(`${a.base}/public/v1/shared/${token.split('.')[0]}.wrong`)).status === 404, 'a wrong token gets nothing');
    ok((await fetch(`${a.base}/api/v1/documents/${up.body.id}/shares`, { method: 'POST', headers: { ...asHelper, 'content-type': 'application/json' }, body: '{"hours":24}' })).status === 403, 'only the owner can create share links');
    await a.call('DELETE', `/api/v1/documents/${up.body.id}/shares/${share.id}`);
    ok((await fetch(`${a.base}/public/v1/shared/${token}`)).status === 404, 'turning a share link off works at once');
    // Copies for people without a Little Dipper: a snapshot as a link, a file or text in an email
    const allJobs = (await a.call('GET', '/api/v1/data/employment')).items;
    await a.call('POST', '/api/v1/copies', { items: [{ domain: 'employment', includeSecret: true }] }, [409]);
    ok(true, 'secret details in a copy need confirmation');
    const cp = await a.call('POST', '/api/v1/copies', { items: [{ domain: 'employment', recordIds: [job.id] }], to: { email: 'Pat.Landlord@example.com', name: 'Pat Okoro' }, delivery: 'link', hours: 168, note: 'For the lease' });
    ok(cp.contact?.created && cp.contact.displayName === 'Pat Okoro' && cp.url.includes('/c/') && cp.copy.link.active, 'sending a link to a new email adds them as a contact');
    ok(cp.email.to === 'Pat.Landlord@example.com' && cp.email.body.includes(cp.url) && cp.email.body.startsWith('Hi Pat'), 'the email is written for the owner’s mail app');
    const cpTok = cp.url.split('/c/')[1];
    const seen = await (await fetch(`${a.base}/public/v1/copies/${cpTok}`)).json();
    ok(seen.title === 'Employment' && seen.categories[0].records.length === 1 && seen.note === 'For the lease', 'the link opens the copy without signing in');
    ok(!seen.categories[0].records[0].fields.some((f: any) => f.key === 'currentPay' || f.key === 'employeeId'), 'secret details stay out unless chosen');
    await a.call('PATCH', `/api/v1/data/employment/${job.id}`, { data: { title: 'Studio director' } });
    const seen2 = await (await fetch(`${a.base}/public/v1/copies/${cpTok}`)).json();
    ok(seen2.categories[0].records[0].title === 'Design lead at Alder Studio', 'a copy is a snapshot: later edits don’t reach it');
    await a.call('PATCH', `/api/v1/data/employment/${job.id}`, { data: { title: 'Design lead' } });
    const pdf = await fetch(`${a.base}/public/v1/copies/${cpTok}/download?format=pdf`);
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    ok(pdf.headers.get('content-type') === 'application/pdf' && pdfBytes.subarray(0, 5).toString() === '%PDF-' && pdfBytes.subarray(-6).toString().includes('%%EOF'), 'the person with the link can save a PDF');
    const cpJson = await (await fetch(`${a.base}/public/v1/copies/${cpTok}/download?format=json`)).json();
    ok(cpJson.format === 'little-dipper.copy/v1' && cpJson.categories[0].entries[0].details.employer === 'Alder Studio', 'and JSON');
    const again = await a.call('POST', '/api/v1/copies', { items: [{ domain: 'employment', recordIds: allJobs.map((j: any) => j.id), includeSecret: true }], to: { email: 'pat.landlord@example.com' }, delivery: 'file', confirm: true });
    ok(!again.contact.created && again.contact.id === cp.contact.id && again.url === null && again.copy.link === null, 'the same email finds the same contact; a file copy has no link');
    const txt = await (await fetch(`${a.base}/api/v1/copies/${again.copy.id}/download?format=txt`, { headers: asOwner() })).text();
    ok(txt.includes('Kiln Co') && txt.includes('$120,000'), 'the owner downloads the file to attach, secret details included when confirmed');
    const inl = await a.call('POST', '/api/v1/copies', { items: [{ domain: 'employment', recordIds: [job.id] }], delivery: 'inline' });
    ok(inl.contact === null && inl.email.body.includes('Alder Studio'), 'in-the-email copies put the text in the message');
    const forPat = await a.call('GET', `/api/v1/copies?contactId=${cp.contact.id}`);
    ok(forPat.items.length === 2 && (await a.call('GET', `/api/v1/contacts/${cp.contact.id}`)).lastActivity.text.startsWith('You sent a copy'), 'the contact page lists what you sent them');
    ok((await fetch(`${a.base}/api/v1/copies`, { method: 'POST', headers: { ...asHelper, 'content-type': 'application/json' }, body: '{}' })).status === 403, 'only the owner’s browser can send copies');
    await a.call('DELETE', `/api/v1/copies/${cp.copy.id}`);
    ok((await fetch(`${a.base}/public/v1/copies/${cpTok}`)).status === 404 && (await fetch(`${a.base}/public/v1/copies/${cpTok}/download?format=pdf`)).status === 404, 'turning the link off works at once');
    const short = await a.call('POST', '/api/v1/copies', { items: [{ domain: 'employment' }], hours: 0 });
    ok(short.copy.link.expiresAt === null && short.copy.link.active, 'a link can run until it’s turned off');
    await a.call('DELETE', `/api/v1/contacts/${cp.contact.id}`);
    ok((await a.call('GET', '/api/v1/copies')).items.length === 4, 'deleting the contact keeps your history of copies');
    await a.call('DELETE', `/api/v1/copies/${inl.copy.id}?forget=1`);
    ok((await a.call('GET', '/api/v1/copies')).items.length === 3, 'a copy can be deleted from your history');
    // Receipts: a photo becomes a receipt document linked to the entry
    const soon = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
    const rc1 = await a.call('POST', '/api/v1/data/receipts', { data: {
      merchant: 'Blue Bottle', purchased: '2026-10-01', total: { amount: 12.5, currency: 'USD' }, returnBy: soon,
      items: [{ description: 'Latte', quantity: 2, price: { amount: 5, currency: 'USD' } }, { description: '', quantity: '' }, { description: 'Scone', price: { amount: 2.5, currency: 'USD' } }],
    } });
    ok(rc1.title === 'Blue Bottle · $12.50' && rc1.data.items.length === 2, 'receipt with line items (blank rows dropped)');
    const rdoc = (await json(await raw('POST', `/api/v1/documents?name=bluebottle.png&link=receipts:${rc1.id}`, png, 'image/png'))).body;
    ok(rdoc.kind === 'receipt' && rdoc.status === 'filed' && rdoc.links[0].title === 'Blue Bottle · $12.50', 'a receipt photo is filed as a receipt document on that receipt');
    await a.call('POST', '/api/v1/data/receipts', { data: { items: [{ quantity: 1 }] } }, [400]);
    ok(true, 'line items need a description');
    const rk = await a.call('POST', '/api/v1/keys', { name: 'Receipt reader', scopes: ['receipts:read', 'receipts:write'] });
    const asRk = { authorization: `Bearer ${rk.secret}` };
    const rc2 = await (await fetch(`${a.base}/api/v1/data/receipts`, { method: 'POST', headers: { ...asRk, 'content-type': 'application/json' }, body: JSON.stringify({ data: { capturedVia: 'assistant', merchant: 'Hardware Co', purchased: '2026-10-15', total: { amount: 89.99, currency: 'USD' } } }) })).json();
    ok((await raw('POST', `/api/v1/documents?name=hw.png&link=receipts:${rc2.id}`, png, 'image/png', asRk)).status === 201, 'a receipts key can file photos on receipts');
    ok((await raw('POST', '/api/v1/documents?name=loose.png', png, 'image/png', asRk)).status === 403, '…but not put documents in the general library');
    ok((await fetch(`${a.base}/api/v1/files/${up.body.pages[0].id}`, { headers: asRk })).status === 403, "…and can't open the license scan");
    const list = (await a.call('GET', '/api/v1/data/receipts')).items;
    ok(list[0].id === rc2.id && list[1].id === rc1.id && list[1].documents.length === 1, 'receipts are ordered by purchase date, with their photos');
    const att = (await a.call('GET', '/api/v1/attention?days=30')).items;
    ok(att.some((x: any) => x.id === rc1.id && x.part === 'Return by' && x.kind === 'deadline'), 'return-by date shows on Home');
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { domains: { receipts: { scope: 'all' } } });
    const shared = (await b.call('GET', `/api/v1/contacts/${cB.id}?sync=1`)).sharedDomains.find((d: any) => d.domain === 'receipts');
    ok(shared?.records.length === 2 && shared.records.some((r: any) => r.data.items?.length === 2), 'shared receipts carry their line items');
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { domains: { receipts: false } });
    // Deleting an entry deletes documents linked only to it, and unlinks shared ones
    await a.call('PATCH', `/api/v1/documents/${up.body.id}`, { links: [{ domain: 'ids', recordId: accepted.record.id }, { domain: 'receipts', recordId: rc1.id }] });
    const del1 = await a.call('DELETE', `/api/v1/data/receipts/${rc1.id}`);
    ok(del1.documentsDeleted === 1 && (await fetch(`${a.base}/api/v1/files/${rdoc.pages[0].id}`, { headers: asOwner() })).status === 404, 'deleting a receipt deletes its photo');
    ok((await a.call('GET', `/api/v1/documents/${up.body.id}`)).links.length === 1, '…while a document linked elsewhere just loses that link');
    // Export and backups include pages
    const tarRes = await fetch(`${a.base}/api/v1/export/documents`, { headers: asOwner() });
    const tarBuf = Buffer.from(await tarRes.arrayBuffer());
    ok(tarRes.status === 200 && tarBuf.subarray(257, 262).toString() === 'ustar' && tarBuf.includes(png), 'documents export is a .tar with the pages');
    const bk1 = await a.call('POST', '/api/v1/node/backups');
    await a.call('DELETE', `/api/v1/documents/${up.body.id}`);
    ok((await fetch(`${a.base}/api/v1/files/${up.body.pages[0].id}`, { headers: asOwner() })).status === 404, 'deleting a document deletes its pages');
    await a.call('POST', `/api/v1/node/backups/${bk1._id ?? bk1.id}/restore`);
    const back = await fetch(`${a.base}/api/v1/files/${up.body.pages[0].id}`, { headers: asOwner() });
    ok(back.status === 200 && Buffer.from(await back.arrayBuffer()).equals(png), 'restoring a backup brings the pages back');
    console.log('public profile sections');
    const visitor = new Client(a.base);
    const resumeDoc = (await json(await raw('POST', '/api/v1/documents?name=maya-resume.png&kind=resume', png, 'image/png'))).body;
    const jobs = (await a.call('GET', '/api/v1/data/employment')).items;
    await a.call('PUT', '/api/v1/public-profile', { sections: [{ type: 'domain', domain: 'employment', parts: ['title', 'currentPay'] }] }, [400]);
    ok(true, 'secret parts can never be public');
    await a.call('PUT', '/api/v1/public-profile', { sections: [{ type: 'domain', domain: 'health' }] }, [400]);
    ok(true, 'non-public categories are refused');
    await a.call('PUT', '/api/v1/public-profile', { sections: [
      { type: 'about', text: 'Ceramicist and product designer in Portland.' }, { type: 'details' },
      { type: 'domain', domain: 'employment', hidden: [jobs[1].id] }, { type: 'resume', documentId: resumeDoc.id },
    ] });
    const pubProf = await visitor.call('GET', '/public/v1/profile');
    const work = pubProf.sections.find((x: any) => x.type === 'domain' && x.domain === 'employment');
    ok(pubProf.sections.map((x: any) => x.type).join(',') === 'about,details,domain,resume' && pubProf.fields.length > 0, 'sections come back in the owner’s order (fields kept for old clients)');
    ok(work.title === 'Work history' && work.items.length === 1 && work.items[0].title === 'Design lead at Alder Studio', 'work history shows chosen jobs, hidden ones stay off');
    ok(!JSON.stringify(work).includes('120000') && !JSON.stringify(work).includes('AS-0042'), 'pay and employee ID never appear');
    const resumeSec = pubProf.sections.find((x: any) => x.type === 'resume');
    ok((await fetch(a.base + resumeSec.document.pages[0].url)).status === 200, 'visitors can download the résumé');
    const other = (await json(await raw('POST', '/api/v1/documents?name=private.png', png, 'image/png'))).body;
    ok((await fetch(`${a.base}/public/v1/profile/files/${other.pages[0].id}`)).status === 404, 'other documents stay private');
    const av = await (await raw('PUT', '/api/v1/public-profile/avatar?name=me.png', png, 'image/png')).json();
    const prof2 = await visitor.call('GET', '/public/v1/profile');
    ok(prof2.avatarUrl === av.avatarUrl && (await fetch(a.base + av.avatarUrl)).status === 200, 'profile photo is public');
    await a.call('PUT', '/api/v1/public-profile', { sections: [{ type: 'details' }] });
    console.log('messaging');
    const wk = await (await fetch(a.base + '/.well-known/little-dipper')).json();
    ok(wk.kind === 'node' && wk.capabilities?.includes('messages'), 'descriptor advertises the messages capability');
    const msg1 = await a.call('POST', `/api/v1/messages/conversations/${cA.id}`, { body: 'Hi Theo, testing messages' });
    ok(msg1.status === 'delivered' && msg1.direction === 'out', 'A messages B and it is delivered');
    ok((await b.call('GET', '/api/v1/messages/unread')).count === 1, 'B has one unread message');
    const convB = await b.call('GET', `/api/v1/messages/conversations/${cB.id}`);
    ok(convB.items.length === 1 && convB.items[0].id === msg1.id && convB.items[0].body === 'Hi Theo, testing messages', 'B stores it under the id A chose');
    await b.call('POST', `/api/v1/messages/conversations/${cB.id}/read`, {});
    ok((await b.call('GET', '/api/v1/messages/unread')).count === 0, 'reading the conversation clears unread');
    const answer = await b.call('POST', `/api/v1/messages/conversations/${cB.id}`, { body: 'Got it', inReplyTo: msg1.id });
    const convA = await a.call('GET', `/api/v1/messages/conversations/${cA.id}`);
    ok(convA.items.length === 2 && convA.items[1].id === answer.id && convA.items[1].inReplyTo === msg1.id, 'B replies and A sees the thread in order');
    // Offline recipient: queued now, delivered by the outbox once B is back.
    // B comes back as a node from before SQLite, so everything after this also runs on a migrated node.
    await new Promise((r) => { B.proc.once('exit', r); B.proc.kill(); });
    const late = await a.call('POST', `/api/v1/messages/conversations/${cA.id}`, { body: 'Are you there?' });
    ok(late.status === 'queued', 'a message to an offline node is queued');
    const docsB = toJsonStore(path.join(tmp, 'b'));
    B = await startNode(4202, path.join(tmp, 'b'));
    ok(!existsSync(path.join(tmp, 'b', 'store.json')) && existsSync(path.join(tmp, 'b', 'store.json.migrated')) && existsSync(path.join(tmp, 'b', 'little-dipper.db')), `B restarts on a JSON store and moves its ${docsB} documents to SQLite`);
    ok((await b.call('GET', '/api/v1/node/status')).claimed && (await b.call('GET', `/api/v1/messages/conversations/${cB.id}`)).items.length === 2, 'after the move B is still claimed, signed in and has its messages');
    let arrived = false;
    for (let i = 0; i < 40 && !arrived; i++) {
      await sleep(250);
      arrived = (await a.call('GET', `/api/v1/messages/conversations/${cA.id}`)).items.some((m: any) => m.id === late.id && m.status === 'delivered');
    }
    ok(arrived, 'the outbox delivers it once the node is back');
    const inboxA = await a.call('GET', '/api/v1/messages/conversations');
    ok(inboxA.items[0].contact.id === cA.id && inboxA.items[0].unread === 1, "A's inbox lists the conversation with one unread");
    await a.call('POST', `/api/v1/messages/conversations/${cA.id}`, { body: '   ' }, [400]);
    ok(true, 'empty messages are refused');
    const msgKey = await a.call('POST', '/api/v1/keys', { name: 'Reader', scopes: ['owner:read'] });
    const noMsg = await fetch(a.base + '/api/v1/messages/conversations', { headers: { authorization: `Bearer ${msgKey.secret}` } });
    ok(noMsg.status === 403, 'app key without messages:read is refused');

    const keys = (await a.call('GET', '/api/v1/keys')).items;
    ok(keys.some((k: any) => k.kind === 'peer') && keys.some((k: any) => k.current), 'keys list shows session and peer token');
    const app = await a.call('POST', '/api/v1/keys', { name: 'Home Assistant', scopes: ['owner:read'] });
    const viaKey = await fetch(a.base + '/api/v1/owner', { headers: { authorization: `Bearer ${app.secret}` } });
    ok(viaKey.status === 200, 'app key with owner:read can read owner');
    const denied = await fetch(a.base + '/api/v1/contacts', { headers: { authorization: `Bearer ${app.secret}` } });
    ok(denied.status === 403, 'app key without contacts:read is refused');

    await a.call('DELETE', `/api/v1/federation/links/${detA.node.linkId}`);
    const afterB = (await b.call('GET', '/api/v1/contacts')).items[0];
    ok(afterB.status === 'plain' && afterB.kind === 'person', 'disconnect leaves B with a plain contact');
    await a.call('POST', `/api/v1/messages/conversations/${cA.id}`, { body: 'Still there?' }, [409]);
    ok((await a.call('GET', `/api/v1/messages/conversations/${cA.id}`)).items.length === 3, 'after disconnect: sending is refused, history is kept');

    console.log('big dipper');
    let bdv = await a.call('GET', '/api/v1/big-dipper');
    ok(bdv.available && bdv.services.length === 3 && bdv.chosen.length === 0 && bdv.settings['upgrades.mode'] === 'notify' && bdv.boundaries.length === 4, 'Big Dipper: available, three services, nothing chosen, notices by default');
    await a.call('PUT', '/api/v1/big-dipper', { services: ['telepathy'] }, [400]);
    await a.call('PUT', '/api/v1/big-dipper', { services: ['upgrades'], settings: { 'upgrades.hosting': 'manual', 'upgrades.mode': 'all' } }, [400]);
    await a.call('PUT', '/api/v1/big-dipper', { services: ['identity', 'upgrades'], settings: { 'upgrades.hosting': 'platform', 'upgrades.mode': 'all', 'identity.recheck': 'biennial' } });
    bdv = await a.call('GET', '/api/v1/big-dipper');
    ok(bdv.chosen.join() === 'identity,upgrades' && bdv.settings['upgrades.mode'] === 'all' && bdv.settings['identity.recheck'] === 'biennial', 'choices are saved; unknown services and options the hosting can’t do are refused');
    await a.call('POST', '/api/v1/big-dipper/connect', { services: [] }, [400]);
    await b.call('PUT', '/api/v1/public-profile', { connectRequests: 'anyone' });
    const bdc = await a.call('POST', '/api/v1/big-dipper/connect', { services: ['interface'] }, [202, 409]);
    bdv = await a.call('GET', '/api/v1/big-dipper');
    ok(bdv.contact && bdv.chosen.join() === 'interface', `connect sends the request (${bdc?.contactId ? 'new' : 'already known'}) and Big Dipper shows as a contact`);
    if (bdc?.contactId) {
      const g = await a.call('GET', `/api/v1/contacts/${bdc.contactId}`);
      ok(!g.grants.profile && !g.grants.fields.length, 'Big Dipper gets no profile and no fields');
    }

    console.log('backups & export');
    const bk = await a.call('POST', '/api/v1/node/backups', {});
    ok(bk.documents > 0, `backup created (${bk.documents} documents)`);
    const exp = await fetch(a.base + '/api/v1/export', { headers: { cookie: [...a.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    const lines = (await exp.text()).trim().split('\n').map((l) => JSON.parse(l));
    ok(lines.some((l) => l.collection === 'fields' && l.value === 'X1234567'), 'export includes decrypted secret values');
    ok(!lines.some((l) => l.collection === 'apiKeys'), 'export excludes credential hashes');
    const before = (await a.call('GET', '/api/v1/data/education')).items.length;
    await a.call('POST', '/api/v1/data/education', { data: { institution: 'After the backup' } });
    await a.call('POST', `/api/v1/node/backups/${bk._id ?? bk.id}/restore`);
    ok((await a.call('GET', '/api/v1/data/education')).items.length === before, 'restoring a backup puts records back as they were');
    const kit = await a.call('POST', '/api/v1/node/recovery-kit', { passphrase: 'correct horse battery' });
    const kitFile = path.join(tmp, 'a.ldkit');
    writeFileSync(kitFile, JSON.stringify(kit));
    let refused = false;
    try { cli(path.join(tmp, 'c'), ['restore-kit', kitFile], 'wrong passphrase\n'); } catch { refused = true; }
    ok(refused && !existsSync(path.join(tmp, 'c', 'keystore.json')), 'a wrong recovery-kit passphrase restores nothing');
    cli(path.join(tmp, 'c'), ['restore-kit', kitFile], 'correct horse battery\n');
    const C = await startNode(4203, path.join(tmp, 'c'));
    await new Promise((r) => { C.proc.once('exit', r); C.proc.kill(); });
    const idOf = (dir: string) => JSON.parse(cli(dir, ['status'])).nodeId;
    ok(idOf(path.join(tmp, 'c')) === idOf(path.join(tmp, 'a')) && idOf(path.join(tmp, 'a')) === kit.nodeId, 'the recovery kit brings back the same node identity on new hardware');
    console.log('\nAll good.');
  } finally {
    A.proc.kill(); B.proc.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
