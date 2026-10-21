import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { startRegistration } from '@simplewebauthn/browser';
import { addr, bytes, copy, del, get, longDate, patch, post, put, saveFile, whenLabel } from '../../api';
import { Confirm, Dialog, Loading, Pills, QR, Toggle, useAction, useAsync, useToast, type ConfirmCfg } from '../../ui';
import { useAdmin } from './Layout';

type Tab = 'address' | 'hosting' | 'backups' | 'security';
const TABS: [Tab, string][] = [['address', 'Address'], ['hosting', 'Hosting'], ['backups', 'Backups'], ['security', 'Security']];

const Step = ({ n, children }: { n: number; children: React.ReactNode }) => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', fontSize: 14 }}>
    <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--color-accent-200)', color: 'var(--color-accent-800)', display: 'grid', placeItems: 'center', fontSize: 12, flex: 'none' }}>{n}</span>
    <span>{children}</span>
  </div>
);

export default function Settings() {
  const { tab: tabParam } = useParams();
  const nav = useNavigate();
  const { tech, setTech } = useAdmin();
  const tab: Tab = TABS.some(([k]) => k === tabParam) ? (tabParam as Tab) : 'address';
  return (
    <div data-screen-label="Node settings" style={{ maxWidth: 960 }}>
      <h1>Settings</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
        <Toggle on={tech} label="Show technical details" onChange={() => setTech(!tech)} />
        <div><div style={{ fontSize: 14, fontWeight: 600 }}>Show technical details</div><div className="text-muted" style={{ fontSize: 12 }}>Keys, endpoints, DNS records and the build reference pages.</div></div>
      </div>
      <Pills value={tab} options={TABS} onChange={(k) => nav(`/admin/settings/${k}`)} style={{ margin: '16px 0 24px' }} size={13} />
      {tab === 'address' && <AddressTab />}
      {tab === 'hosting' && <HostingTab />}
      {tab === 'backups' && <BackupsTab />}
      {tab === 'security' && <SecurityTab />}
    </div>
  );
}

function AddressTab() {
  const { node, tech, refresh } = useAdmin();
  const toast = useToast();
  const { run, busy } = useAction();
  const [domain, setDomain] = useState('');
  const [kit, setKit] = useState<{ a: string; b: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [check, setCheck] = useState<{ txt: boolean; reachable: boolean } | null>(null);
  const a = node.addresses;
  const hostLabel = `Address from ${node.hosting.label === 'Self-hosted' ? 'your server' : node.hosting.label}`;
  const active = a.domainStatus === 'active';

  const rows = active
    ? [{ k: 'Web address', v: a.domain!, tag: tech ? 'TLS active' : 'Secure', cls: 'tag-accent-2' }, { k: hostLabel, v: addr(a.host), tag: 'Still works', cls: 'tag-neutral' }]
    : [{ k: hostLabel, v: addr(a.host), tag: 'Current', cls: 'tag-accent-2' }, { k: 'Custom domain', v: a.domain || 'None yet', tag: a.domain ? 'Waiting for DNS' : 'Optional', cls: 'tag-neutral' }];

  const downloadKit = async () => {
    if (!kit) return;
    if (kit.a !== kit.b) return toast("The passphrases don't match");
    const r = await run(() => post('/api/v1/node/recovery-kit', { passphrase: kit.a }));
    if (r) {
      saveFile(`little-dipper-${node.id}.ldkit`, JSON.stringify(r, null, 2));
      setKit(null);
      toast('Recovery kit downloaded');
    }
  };
  const connect = async () => {
    if (await run(() => patch('/api/v1/node', { domain }), `Now point ${domain} here`)) refresh();
  };
  const checkDns = async () => {
    const r = await run(() => post<{ txt: boolean; reachable: boolean; node: { addresses: { domainStatus: string } } }>('/api/v1/node/domain/check'));
    if (!r) return;
    setCheck(r);
    if (r.node.addresses.domainStatus === 'active') { toast(`${a.domain} connected. Your contacts were told automatically.`); refresh(); }
  };
  const removeDomain = () => setConfirm({
    title: active ? `Stop using ${a.domain}?` : `Cancel ${a.domain}?`,
    body: active ? `People will reach you at ${addr(a.host)} again. Your contacts are told automatically, and ${a.domain} redirects there for 90 days.` : 'You can connect a domain again any time.',
    cta: active ? 'Change domain' : 'Cancel domain',
    onConfirm: async () => { if (await run(() => patch('/api/v1/node', { domain: null }))) refresh(); setConfirm(null); },
  });

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="card" style={{ padding: '22px 24px', gap: 10, background: 'var(--color-accent-2-100)' }}>
        <div className="card-kicker" style={{ color: 'var(--color-accent-2-800)' }}>Permanent identity</div>
        <div className="card-title" style={{ fontSize: 20 }}>Your ID never changes</div>
        <div style={{ fontSize: 14, color: 'var(--color-accent-2-900)', maxWidth: 620 }}>Contacts know you by this ID, not your web address. If your domain or IP address changes, their Little Dippers follow you automatically.</div>
        <div className="mono" style={{ fontSize: 13, background: 'var(--color-neutral-100)', borderRadius: 999, padding: '8px 16px', width: 'max-content', maxWidth: '100%', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.id}</div>
        {tech && <div className="mono" style={{ fontSize: 12, color: 'var(--color-accent-2-800)' }}>Signing key {node.signingKey}</div>}
        <div style={{ fontSize: 13, color: 'var(--color-accent-2-800)', maxWidth: 620 }}>Keep your recovery kit somewhere safe. It's the only way to bring this ID, and every connection, to a new server.</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => setKit({ a: '', b: '' })}>Download recovery kit</button>
          {tech && <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => post<{ notified: string[] }>('/api/v1/node/address-change/announce'), (r) => (r.notified.length ? `Told ${r.notified.length} connection${r.notified.length === 1 ? '' : 's'} your address` : 'No connections to tell yet'))}>Send address-change notice</button>}
        </div>
      </div>

      <div className="card" style={{ padding: '22px 24px', gap: 10 }}>
        <div className="card-kicker">Where people find you</div>
        {rows.map((r) => (
          <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--color-divider)', flexWrap: 'wrap' }}>
            <span className="text-muted" style={{ fontSize: 13 }}>{r.k}</span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="mono" style={{ fontSize: 13 }}>{r.v}</span><span className={`tag ${r.cls}`}>{r.tag}</span></span>
          </div>
        ))}
        {active && <button className="btn btn-secondary" onClick={removeDomain} style={{ alignSelf: 'flex-start' }}>Change domain</button>}
      </div>

      {!active && (
        <div className="card" style={{ padding: '22px 24px', gap: 12 }}>
          <div className="card-kicker">Use your own domain</div>
          <div className="card-title" style={{ fontSize: 20 }}>Give your space a name people can remember</div>
          <div style={{ fontSize: 14, maxWidth: 620 }}>Right now people reach you at the address {node.hosting.label === 'Self-hosted' ? 'your server has' : `${node.hosting.label} gave you`}. If you own a domain (or buy one from Namecheap, GoDaddy, Squarespace…), we'll walk you through pointing it here. It takes about 10 minutes, plus time for the internet to catch up.</div>
          <div style={{ display: 'grid', gap: 8, maxWidth: 620 }}>
            <Step n={1}>Type the domain you want to use.</Step>
            <Step n={2}>We'll show you the settings to copy into your domain provider's site.</Step>
            <Step n={3}>We check and switch you over once it's working. Your host provides the secure certificate.</Step>
          </div>
          {!a.domain ? (
            <form style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }} onSubmit={(e) => { e.preventDefault(); connect(); }}>
              <input className="input" aria-label="Your domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="yourname.com" style={{ maxWidth: 280 }} />
              <button type="submit" className="btn btn-primary" disabled={busy || !domain.trim()}>Connect domain</button>
            </form>
          ) : (
            <>
              <div style={{ fontSize: 14 }}>Add these at your domain provider for <strong>{a.domain}</strong>:</div>
              <div style={{ overflowX: 'auto' }}>
                <table className="table mono" style={{ fontSize: 12.5 }}>
                  <thead><tr><th>Type</th><th>Name</th><th>Value</th></tr></thead>
                  <tbody>{a.records.filter((r) => r.type !== 'CNAME').map((r) => <tr key={r.type + r.name}><td>{r.type}</td><td>{r.name}</td><td style={{ overflowWrap: 'anywhere' }}>{r.value}</td></tr>)}</tbody>
                </table>
              </div>
              <div className="text-muted" style={{ fontSize: 12 }}>No ALIAS option at your provider? Use a CNAME on <span className="mono">www</span> instead, and also add it in your host's custom-domain settings.</div>
              {check && <div style={{ fontSize: 13, color: 'var(--color-accent-800)' }}>{!check.txt ? "We can't see the TXT record yet." : !check.reachable ? `The TXT record is there, but ${a.domain} doesn't reach this Little Dipper yet.` : 'All set.'} DNS changes can take up to an hour.</div>}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-primary" disabled={busy} onClick={checkDns}>Check now</button>
                <button className="btn btn-ghost" onClick={removeDomain}>Use a different domain</button>
              </div>
            </>
          )}
        </div>
      )}

      {tech && a.domain && (
        <div className="card" style={{ padding: '22px 24px', gap: 10 }}>
          <div className="card-kicker">DNS records</div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table mono" style={{ fontSize: 12.5 }}>
              <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Status</th></tr></thead>
              <tbody>{a.records.map((r) => <tr key={r.type + r.name}><td>{r.type}</td><td>{r.name}</td><td>{r.value}</td><td><span className={`tag ${active ? 'tag-accent-2' : 'tag-neutral'}`}>{active ? 'Verified' : 'Waiting'}</span></td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}

      {kit && (
        <Dialog title="Download recovery kit" onClose={() => setKit(null)} actions={<>
          <button className="btn btn-secondary" onClick={() => setKit(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || kit.a.length < 10} onClick={downloadKit}>Download</button>
        </>}>
          <div className="dialog-body">The kit holds your signing key and backup key, encrypted with a passphrase you choose. You'll need both the file and the passphrase to restore.</div>
          <div className="field"><label htmlFor="k1">Passphrase (10+ characters)</label><input id="k1" className="input" type="password" autoComplete="new-password" value={kit.a} onChange={(e) => setKit({ ...kit, a: e.target.value })} /></div>
          <div className="field"><label htmlFor="k2">Again</label><input id="k2" className="input" type="password" autoComplete="new-password" value={kit.b} onChange={(e) => setKit({ ...kit, b: e.target.value })} /></div>
        </Dialog>
      )}
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

function HostingTab() {
  const { node, tech, refresh } = useAdmin();
  const { run, busy } = useAction();
  const u = node.update;
  const rows: [string, string][] = [
    ['Provider', node.hosting.label],
    ...(node.hosting.region ? [['Region', node.hosting.region] as [string, string]] : []),
    ...(tech ? [['Database', `${node.hosting.store} · ${node.hosting.documents} documents`], ['Version', node.version], ['Claimed', node.claimedAt ? longDate(node.claimedAt) : '—']] as [string, string][] : [['Stored', `${node.hosting.documents} records`]] as [string, string][]),
  ];
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="card" style={{ padding: '22px 24px', gap: 10 }}>
        <div className="card-kicker">Hosting</div>
        {rows.map(([k, v]) => <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--color-divider)', fontSize: 14, flexWrap: 'wrap' }}><span className="text-muted">{k}</span><span>{v}</span></div>)}
      </div>
      <div className="card" style={{ padding: '22px 24px', gap: 10, background: 'var(--color-accent-100)' }}>
        <div className="card-kicker">{u.available ? 'Update available' : 'Up to date'}</div>
        <div className="card-title">Little Dipper {u.available ? u.latest : u.current}</div>
        <div className="card-body">{u.available ? `${u.notes || 'A new release is ready.'} A backup is taken before updating.` : "You're on the latest release we know about."}</div>
        {u.available && <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => post('/api/v1/node/update'), `Updating to ${u.latest}. This takes a few minutes.`)) refresh(); }} style={{ alignSelf: 'flex-start' }}>Update now</button>}
      </div>
    </div>
  );
}

type Backup = { _id: string; at: string; size: number; documents: number; reason: string; available: boolean };
function BackupsTab() {
  const toast = useToast();
  const nav = useNavigate();
  const { refresh } = useAdmin();
  const { run, busy } = useAction();
  const { data, reload } = useAsync(() => get<{ items: Backup[]; schedule: string; destination: string }>('/api/v1/node/backups'), []);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  if (!data) return <Loading />;
  const exportAll = async () => {
    const r = await fetch('/api/v1/export', { credentials: 'same-origin' });
    if (!r.ok) return toast('Export failed');
    const name = `little-dipper-export-${new Date().toISOString().slice(0, 10)}.jsonl`;
    saveFile(name, await r.text(), 'application/x-ndjson');
    toast(`Exported · ${name}`);
  };
  const restore = (b: Backup) => setConfirm({
    title: `Restore the backup from ${whenLabel(b.at)}?`,
    body: `Everything goes back to how it was then (${b.documents} documents). A safety backup of right now is taken first.`,
    cta: 'Restore',
    onConfirm: async () => { if (await run(() => post(`/api/v1/node/backups/${b._id}/restore`), 'Backup restored')) { setConfirm(null); refresh(); nav('/admin'); } },
  });
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="card" style={{ padding: '22px 24px', gap: 10 }}>
        <div className="card-kicker">Schedule</div>
        <div style={{ fontSize: 15 }}>{data.schedule}</div>
        <div className="text-muted mono" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>Destination: {data.destination}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <button className="btn btn-primary" disabled={busy} onClick={async () => { if (await run(() => post('/api/v1/node/backups'), 'Backup complete')) { reload(); refresh(); } }}>Back up now</button>
          <button className="btn btn-secondary" onClick={exportAll}>Export everything (JSON)</button>
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>Backup</th><th>Size</th><th>Documents</th><th></th></tr></thead>
          <tbody>
            {data.items.map((b) => (
              <tr key={b._id}>
                <td>{whenLabel(b.at)}{b.reason !== 'scheduled' && <span className="text-muted" style={{ fontSize: 12 }}> · {b.reason.replace('-', ' ')}</span>}</td>
                <td>{bytes(b.size)}</td><td>{b.documents}</td>
                <td style={{ textAlign: 'right' }}>{b.available ? <button className="btn btn-ghost" onClick={() => restore(b)} style={{ fontSize: 13 }}>Restore</button> : <span className="text-muted" style={{ fontSize: 12 }}>File missing</span>}</td>
              </tr>
            ))}
            {data.items.length === 0 && <tr><td colSpan={4} className="text-muted" style={{ fontSize: 14 }}>No backups yet. The first nightly backup runs at 03:00.</td></tr>}
          </tbody>
        </table>
      </div>
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}

type Security = { passkeys: { id: string; label: string; createdAt: string; lastUsedAt: string | null }[]; password: boolean; totp: boolean; recoveryCodes: { total: number; unused: number } };
function SecurityTab() {
  const toast = useToast();
  const nav = useNavigate();
  const { run, busy } = useAction();
  const { data, reload } = useAsync(() => get<Security>('/api/v1/auth/security'), []);
  const [confirm, setConfirm] = useState<ConfirmCfg | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [fallback, setFallback] = useState<{ step: 'pw' | 'totp'; pw: string; pw2: string; otpauth?: string; secret?: string; code: string } | null>(null);
  const [transfer, setTransfer] = useState<{ url: string; expiresAt: string } | null>(null);
  const [resetText, setResetText] = useState<string | null>(null);
  if (!data) return <Loading />;
  const fallbackOn = data.password && data.totp;

  const addPasskey = async () => {
    try {
      const { challengeId, options } = await post('/api/v1/auth/passkeys/register/options');
      const response = await startRegistration({ optionsJSON: options });
      await post('/api/v1/auth/passkeys/register', { challengeId, response });
      toast('Passkey added');
      reload();
    } catch (e) {
      toast((e as Error).name === 'NotAllowedError' ? 'Passkey creation was cancelled' : (e as Error).message);
    }
  };
  const fallbackNext = async () => {
    if (!fallback) return;
    if (fallback.step === 'pw') {
      if (fallback.pw !== fallback.pw2) return toast("The passwords don't match");
      if (!(await run(() => put('/api/v1/auth/password', { password: fallback.pw })))) return;
      const t = await run(() => post<{ otpauth: string; secret: string }>('/api/v1/auth/totp/setup'));
      if (t) setFallback({ ...fallback, step: 'totp', otpauth: t.otpauth, secret: t.secret });
    } else if (await run(() => post('/api/v1/auth/totp/enable', { code: fallback.code }), 'Password sign-in is on')) {
      setFallback(null);
      reload();
    }
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="card" style={{ padding: '22px 24px', gap: 10 }}>
        <div className="card-kicker">Passkeys</div>
        {data.passkeys.map((p) => (
          <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--color-divider)', fontSize: 14, flexWrap: 'wrap', alignItems: 'center' }}>
            <span>{p.label}</span>
            <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span className="text-muted">Added {longDate(p.createdAt)}</span>
              {(data.passkeys.length > 1 || fallbackOn) && <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setConfirm({ title: `Remove ${p.label}?`, body: "That device won't be able to sign in any more.", cta: 'Remove', onConfirm: async () => { if (await run(() => del(`/api/v1/auth/passkeys/${encodeURIComponent(p.id)}`), 'Passkey removed')) reload(); setConfirm(null); } })}>Remove</button>}
            </span>
          </div>
        ))}
        <button className="btn btn-secondary" onClick={addPasskey} style={{ alignSelf: 'flex-start' }}>Add passkey</button>
      </div>

      <div className="card" style={{ padding: '22px 24px', gap: 8 }}>
        <div className="card-kicker">Fallback sign-in</div>
        <div style={{ fontSize: 14 }}>Password + authenticator app · {fallbackOn ? 'on' : 'off'}</div>
        <div style={{ fontSize: 14 }}>Recovery codes · {data.recoveryCodes.unused} of {data.recoveryCodes.total} unused</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {fallbackOn
            ? <button className="btn btn-secondary" onClick={() => setConfirm({ title: 'Turn off password sign-in?', body: 'You will sign in with a passkey or a recovery code only.', cta: 'Turn off', onConfirm: async () => { if (await run(() => post('/api/v1/auth/fallback/disable'), 'Password sign-in is off')) reload(); setConfirm(null); } })}>Turn off password sign-in</button>
            : <button className="btn btn-secondary" onClick={() => setFallback({ step: 'pw', pw: '', pw2: '', code: '' })}>Set up password sign-in</button>}
          <button className="btn btn-secondary" onClick={() => setConfirm({ title: 'Regenerate recovery codes?', body: 'Your current codes stop working immediately.', cta: 'Regenerate', onConfirm: async () => { const r = await run(() => post<{ codes: string[] }>('/api/v1/auth/recovery-codes')); setConfirm(null); if (r) { setCodes(r.codes); reload(); } } })}>Regenerate recovery codes</button>
        </div>
      </div>

      <div style={{ borderRadius: 32, border: '2px solid var(--color-accent-300)', padding: '22px 24px', display: 'grid', gap: 10 }}>
        <div className="card-kicker">Danger zone</div>
        <div style={{ fontSize: 14 }}>Transfer ownership issues a new claim link to another person and removes your access when they claim.</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" onClick={() => setConfirm({ title: 'Transfer ownership?', body: "We'll create a link that's valid for 24 hours. Whoever completes setup with it becomes the owner, and your passkeys and sessions stop working. Your data stays.", cta: 'Create transfer link', onConfirm: async () => { const r = await run(() => post<{ url: string; expiresAt: string }>('/api/v1/node/transfer')); setConfirm(null); if (r) setTransfer(r); } })}>Transfer ownership</button>
          <button className="btn btn-secondary" onClick={() => setResetText('')} style={{ color: 'var(--color-accent-700)' }}>Reset node to unclaimed</button>
        </div>
      </div>

      {codes && (
        <Dialog title="New recovery codes" onClose={() => setCodes(null)} actions={<>
          <button className="btn btn-secondary" onClick={() => { saveFile('little-dipper-recovery.txt', `Little Dipper recovery codes\nEach code works once.\n\n${codes.join('\n')}\n`, 'text/plain'); toast('Codes saved as little-dipper-recovery.txt'); }}>Download codes</button>
          <button className="btn btn-primary" onClick={() => setCodes(null)}>Done</button>
        </>}>
          <div className="dialog-body">Store these somewhere safe. Each one signs you in once. They won't be shown again.</div>
          <div className="mono" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: 8, fontSize: 14 }}>
            {codes.map((c) => <div key={c} style={{ background: 'var(--color-neutral-100)', borderRadius: 999, padding: '8px 14px', textAlign: 'center' }}>{c}</div>)}
          </div>
        </Dialog>
      )}

      {fallback && (
        <Dialog title="Set up password sign-in" onClose={() => setFallback(null)} actions={<>
          <button className="btn btn-secondary" onClick={() => setFallback(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || (fallback.step === 'pw' ? fallback.pw.length < 12 : fallback.code.length < 6)} onClick={fallbackNext}>{fallback.step === 'pw' ? 'Continue' : 'Turn on'}</button>
        </>}>
          {fallback.step === 'pw' ? (
            <>
              <div className="dialog-body">For when you don't have a passkey device with you. You'll also need a code from an authenticator app.</div>
              <div className="field"><label htmlFor="p1">Password (12+ characters)</label><input id="p1" className="input" type="password" autoComplete="new-password" value={fallback.pw} onChange={(e) => setFallback({ ...fallback, pw: e.target.value })} /></div>
              <div className="field"><label htmlFor="p2">Again</label><input id="p2" className="input" type="password" autoComplete="new-password" value={fallback.pw2} onChange={(e) => setFallback({ ...fallback, pw2: e.target.value })} /></div>
            </>
          ) : (
            <>
              <div className="dialog-body">Scan this with your authenticator app, then enter the 6-digit code it shows.</div>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
                <QR text={fallback.otpauth!} size={140} />
                <div className="mono text-muted" style={{ fontSize: 12, overflowWrap: 'anywhere', flex: 1, minWidth: 160 }}>Can't scan? Enter this key:<br />{fallback.secret}</div>
              </div>
              <div className="field"><label htmlFor="tc">6-digit code</label><input id="tc" className="input mono" inputMode="numeric" autoComplete="one-time-code" value={fallback.code} onChange={(e) => setFallback({ ...fallback, code: e.target.value })} placeholder="000 000" style={{ letterSpacing: '.2em', fontSize: 18 }} /></div>
            </>
          )}
        </Dialog>
      )}

      {transfer && (
        <Dialog title="Transfer link" onClose={() => setTransfer(null)} actions={<>
          <button className="btn btn-secondary" onClick={() => setTransfer(null)}>Done</button>
          <button className="btn btn-primary" onClick={async () => { await copy(transfer.url); toast('Transfer link copied'); }}>Copy link</button>
        </>}>
          <div className="dialog-body">Give this to the new owner. It works once and expires {longDate(transfer.expiresAt)}. You keep access until they finish setup.</div>
          <div className="mono" style={{ fontSize: 12, background: 'var(--color-neutral-100)', borderRadius: 16, padding: '10px 14px', overflowWrap: 'anywhere' }}>{transfer.url}</div>
        </Dialog>
      )}

      {resetText !== null && (
        <Dialog title="Reset to unclaimed?" onClose={() => setResetText(null)} actions={<>
          <button className="btn btn-secondary" onClick={() => setResetText(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || resetText !== 'RESET'} onClick={async () => { if (await run(() => post('/api/v1/node/reset', { confirm: 'RESET' }))) nav('/', { replace: true }); }}>Reset</button>
        </>}>
          <div className="dialog-body">This deletes the owner, all your data, contacts and keys, and prints a new claim link to the server logs. Your permanent ID stays. A backup is taken first.</div>
          <div className="field"><label htmlFor="rs">Type RESET to confirm</label><input id="rs" className="input mono" value={resetText} onChange={(e) => setResetText(e.target.value)} /></div>
        </Dialog>
      )}
      {confirm && <Confirm cfg={confirm} onClose={() => setConfirm(null)} />}
    </div>
  );
}
