/**
 * End-to-end smoke test: two Little Dippers on localhost, claimed with a software
 * passkey, then connected through an invite link, sharing fields both ways.
 *
 *   npx tsx scripts/smoke.ts            (starts two servers on 4201/4202 in a temp dir)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function startNode(port: number, dir: string): Promise<{ proc: ChildProcess; claimUrl: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', 'src/server.ts'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), LD_DATA_DIR: dir, LOG_LEVEL: 'warn', LD_PUBLIC_URL: `http://localhost:${port}`, LD_RETRY_BASE_MS: '300' } });
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

async function main() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ld-smoke-'));
  const [A, firstB] = await Promise.all([startNode(4201, path.join(tmp, 'a')), startNode(4202, path.join(tmp, 'b'))]);
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
    await a.call('POST', '/api/v1/contact_methods', { data: { kind: 'phone', label: 'Mobile', value: '+1 (503) 555-0148', primary: true } });
    await a.call('POST', '/api/v1/residences', { data: { street1: '2214 SE Ankeny St', city: 'Portland', region: 'OR', postalCode: '97214', country: 'us', ownership: 'rent' }, validFrom: '2019-06' });
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
    ok(cat.length >= 20 && cat.some((d: any) => d.id === 'employment' && d.endpoint === '/api/v1/employment'), `catalog lists ${cat.length} domains`);
    // Residences feed the derived profile fields
    const res = (await a.call('GET', '/api/v1/residences')).items[0];
    await a.call('POST', '/api/v1/residences', { data: { street1: '12 Kungsgatan', city: 'Stockholm', country: 'SE' }, validFrom: '2012-01', validTo: '2019-05' });
    let prof = (await a.call('GET', '/api/v1/owner/fields')).items;
    ok(prof.find((f: any) => f.key === 'address').value.startsWith('2214 SE Ankeny St, Portland, OR 97214') && prof.find((f: any) => f.key === 'country_res').value === 'United States', 'current residence feeds Current address + Country of residence');
    await a.call('PUT', '/api/v1/owner/fields/address', { value: 'elsewhere' }, [409]);
    ok(true, 'derived field refuses direct edits');
    const cur = (await a.call('GET', '/api/v1/residences?current=true')).items;
    ok(cur.length === 1 && cur[0].id === res.id && cur[0].title === '2214 SE Ankeny St, Portland', 'current=true returns the current residence');
    await a.call('POST', '/api/v1/residences', { data: { street1: 'x' } }, [400]);
    await a.call('POST', '/api/v1/residences', { data: { street1: 'x', city: 'y', country: 'US', nope: 1 } }, [400]);
    await a.call('POST', '/api/v1/residences', { data: { street1: 'x', city: 'y', country: 'US' }, validFrom: '2020-01', validTo: '2019-01' }, [400]);
    await a.call('POST', '/api/v1/financial_accounts', { data: { kind: 'checking', institution: 'Harbor CU', last4: '4111111111111111' } }, [400]);
    ok(true, 'validation: required parts, unknown parts, date order, last-4 only');
    // Employment with secret pay
    const job = await a.call('POST', '/api/v1/employment', { data: { employer: 'Alder Studio', title: 'Product designer', city: 'Portland', country: 'US', currentPay: { amount: 120000, currency: 'usd' }, employeeId: 'AS-0042' }, validFrom: '2021-03' });
    await a.call('POST', '/api/v1/employment', { data: { employer: 'Kiln Co', title: 'Ceramicist' }, validFrom: '2016-01', validTo: '2021-02' });
    ok(job.title === 'Product designer at Alder Studio' && job.masked.includes('currentPay') && job.data.employeeId.startsWith('••••'), 'secret parts are masked');
    const rev = await a.call('POST', `/api/v1/employment/${job.id}/reveal`, {});
    ok(rev.data.currentPay.amount === 120000 && rev.data.employeeId === 'AS-0042', 'reveal decrypts secret parts');
    const upd = await a.call('PATCH', `/api/v1/employment/${job.id}`, { data: { title: 'Design lead', department: 'Product' } });
    const rev2 = await a.call('POST', `/api/v1/employment/${job.id}/reveal`, {});
    ok(upd.title === 'Design lead at Alder Studio' && rev2.data.employeeId === 'AS-0042', 'patch keeps untouched secret parts');
    await a.call('POST', '/api/v1/ids', { data: { kind: 'passport', number: 'P1234567', issuer: 'US', expires: '2031-04' } });
    const tl = (await a.call('GET', '/api/v1/timeline')).items;
    ok(tl.length >= 4 && tl[0].validFrom >= tl[tl.length - 1].validFrom, `timeline merges ${tl.length} dated records`);
    // Custom domain
    const wine = await a.call('POST', '/api/v1/catalog', { label: 'Wine cellar', parts: [{ label: 'Wine', type: 'text', required: true }, { label: 'Vintage', type: 'number' }], dated: false });
    await a.call('POST', `/api/v1/${wine.id}`, { data: { Wine: 'Willamette Pinot', Vintage: 2018 } });
    ok(wine.id === 'x_wine_cellar' && (await a.call('GET', `/api/v1/${wine.id}`)).items.length === 1, 'custom category works like a built-in one');
    // Scoped app key
    const emp = await a.call('POST', '/api/v1/keys', { name: 'Resume builder', scopes: ['employment:read'] });
    const auth = { headers: { authorization: `Bearer ${emp.secret}` } };
    ok((await fetch(a.base + '/api/v1/employment', auth)).status === 200 && (await fetch(a.base + '/api/v1/ids', auth)).status === 403, 'employment:read key reads jobs but not IDs');
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
    await a.call('POST', '/api/v1/education', { data: { institution: 'Konstfack', degree: 'MFA' }, validFrom: '2012-09', validTo: '2014-06' });
    await sleep(3000);
    detB = await b.call('GET', `/api/v1/contacts/${cB.id}`);
    ok(detB.sharedDomains.some((d: any) => d.domain === 'education' && d.records.length === 1), 'grant + edit nudge B to sync without asking');
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { domains: { education: false } });
    console.log('receipts');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const cookieOf = (c: Client) => [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const upload = (bytes: Buffer, type: string, domain = 'receipts', headers: Record<string, string> = { cookie: cookieOf(a) }) =>
      fetch(`${a.base}/api/v1/files?domain=${domain}&name=receipt.png`, { method: 'POST', headers: { origin: a.base, 'content-type': type, ...headers }, body: bytes });
    const up1 = await upload(png, 'image/png');
    const file1 = await up1.json();
    ok(up1.status === 201 && file1.id.startsWith('fil_') && file1.size === png.length, 'upload a receipt photo');
    ok((await upload(Buffer.from('not really a png'), 'image/png')).status === 400, 'contents must match the declared type');
    ok((await upload(Buffer.from('hello'), 'text/plain')).status === 415, 'only photos and PDFs are accepted');
    ok((await upload(png, 'image/png', 'employment')).status === 400, "categories without files don't take uploads");
    const soon = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
    const rc1 = await a.call('POST', '/api/v1/receipts', { data: {
      merchant: 'Blue Bottle', purchased: '2026-10-01', total: { amount: 12.5, currency: 'USD' }, files: [file1.id], returnBy: soon,
      items: [{ description: 'Latte', quantity: 2, price: { amount: 5, currency: 'USD' } }, { description: '', quantity: '' }, { description: 'Scone', price: { amount: 2.5, currency: 'USD' } }],
    } });
    ok(rc1.title === 'Blue Bottle · $12.50' && rc1.data.items.length === 2 && rc1.data.files[0].name === 'receipt.png', 'receipt with line items and a photo (blank rows dropped)');
    const got = await fetch(`${a.base}/api/v1/files/${file1.id}`, { headers: { cookie: cookieOf(a) } });
    ok(got.status === 200 && got.headers.get('content-type') === 'image/png' && Buffer.from(await got.arrayBuffer()).equals(png), 'the photo comes back byte for byte');
    await a.call('POST', '/api/v1/receipts', { data: { merchant: 'Elsewhere', files: [file1.id] } }, [400]);
    ok(true, "a file can't be attached to two receipts");
    await a.call('POST', '/api/v1/receipts', { data: { items: [{ quantity: 1 }] } }, [400]);
    ok(true, 'line items need a description');
    // An assistant with receipts:write: upload a photo, file it, fill the details in later.
    const helper = await a.call('POST', '/api/v1/keys', { name: 'Receipt reader', scopes: ['receipts:read', 'receipts:write'] });
    const asHelper = { authorization: `Bearer ${helper.secret}` };
    const file2 = await (await upload(png, 'image/png', 'receipts', asHelper)).json();
    const rc2 = await (await fetch(`${a.base}/api/v1/receipts`, { method: 'POST', headers: { ...asHelper, 'content-type': 'application/json' }, body: JSON.stringify({ data: { files: [file2.id], capturedVia: 'assistant' } }) })).json();
    ok(rc2.title === 'receipt' && !rc2.data.merchant, 'a photo alone is a receipt (needs details)');
    const filled = await (await fetch(`${a.base}/api/v1/receipts/${rc2.id}`, { method: 'PATCH', headers: { ...asHelper, 'content-type': 'application/json' }, body: JSON.stringify({ data: { merchant: 'Hardware Co', purchased: '2026-10-15', total: { amount: 89.99, currency: 'USD' }, warrantyUntil: '2028-10-15' } }) })).json();
    ok(filled.title === 'Hardware Co · $89.99' && filled.data.files.length === 1, 'the assistant key fills in the details');
    ok((await fetch(`${a.base}/api/v1/files/${file1.id}`, auth)).status === 403, 'a key without receipts scope cannot open receipt files');
    const list = (await a.call('GET', '/api/v1/receipts')).items;
    ok(list[0].id === rc2.id && list[1].id === rc1.id, 'receipts are ordered by purchase date');
    const att = (await a.call('GET', '/api/v1/attention?days=30')).items;
    ok(att.some((x: any) => x.id === rc1.id && x.part === 'Return by' && x.kind === 'deadline'), 'return-by date shows on Home');
    // Sharing receipts: line items go, file ids don't.
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { domains: { receipts: { scope: 'all' } } });
    const shared = (await b.call('GET', `/api/v1/contacts/${cB.id}?sync=1`)).sharedDomains.find((d: any) => d.domain === 'receipts');
    ok(shared?.records.length === 2 && shared.records.every((r: any) => !('files' in r.data)) && shared.records.some((r: any) => r.data.items?.length === 2), 'shared receipts carry items, not file ids');
    await a.call('PUT', `/api/v1/contacts/${cA.id}/grants`, { domains: { receipts: false } });
    // Dropping a file from a receipt deletes it; deleting the receipt deletes the rest.
    await a.call('PATCH', `/api/v1/receipts/${rc2.id}`, { data: { files: null } });
    ok((await fetch(`${a.base}/api/v1/files/${file2.id}`, { headers: { cookie: cookieOf(a) } })).status === 404, 'removing a photo from a receipt deletes the file');
    await a.call('DELETE', `/api/v1/receipts/${rc1.id}`);
    ok((await fetch(`${a.base}/api/v1/files/${file1.id}`, { headers: { cookie: cookieOf(a) } })).status === 404, 'deleting a receipt deletes its photo');
    const loose = await (await upload(png, 'image/png')).json();
    ok((await a.call('DELETE', `/api/v1/files/${loose.id}`)).deleted, 'an upload never saved on a receipt can be deleted');
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
    B.proc.kill();
    await sleep(300);
    const late = await a.call('POST', `/api/v1/messages/conversations/${cA.id}`, { body: 'Are you there?' });
    ok(late.status === 'queued', 'a message to an offline node is queued');
    B = await startNode(4202, path.join(tmp, 'b'));
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

    console.log('backups & export');
    const bk = await a.call('POST', '/api/v1/node/backups', {});
    ok(bk.documents > 0, `backup created (${bk.documents} documents)`);
    const exp = await fetch(a.base + '/api/v1/export', { headers: { cookie: [...a.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    const lines = (await exp.text()).trim().split('\n').map((l) => JSON.parse(l));
    ok(lines.some((l) => l.collection === 'fields' && l.value === 'X1234567'), 'export includes decrypted secret values');
    ok(!lines.some((l) => l.collection === 'apiKeys'), 'export excludes credential hashes');
    console.log('\nAll good.');
  } finally {
    A.proc.kill(); B.proc.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
