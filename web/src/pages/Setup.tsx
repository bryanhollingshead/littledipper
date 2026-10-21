import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { startRegistration } from '@simplewebauthn/browser';
import { addr, get, post, saveFile } from '../api';
import { Brand, Circle, Loading, Pills, useToast } from '../ui';

type Status = { claimed: boolean; version: string; address: string; hosting: { label: string; region: string }; storage: string };
type HostTab = 'render' | 'docker' | 'vps' | 'home';

const HOST: Record<HostTab, { label: string; text: string; cmd: string; out: (a: string) => string; note: string }> = {
  render: { label: 'Render / one-click', text: 'The install button opened your claim link automatically. If you closed that tab, the link is also in your service logs from the first boot.', cmd: 'Render → your service → Logs', out: (a) => `Claim this node: https://${a}/claim?token=ct_…`, note: 'Expired? Open the Render Shell and run: little-dipper claim-link' },
  docker: { label: 'Docker', text: 'The link prints to the container logs on first boot. Anyone who can read those logs controls the server, so it proves you deployed it.', cmd: '$ docker logs little-dipper | grep claim', out: (a) => `Claim this node: https://${a}/claim?token=ct_…`, note: 'Expired? Run: docker exec little-dipper little-dipper claim-link' },
  vps: { label: 'Server / VPS', text: 'Run the CLI on the machine. It prints a fresh link, valid for 1 hour, and invalidates any earlier one.', cmd: '$ sudo little-dipper claim-link', out: (a) => `https://${a}/claim?token=ct_…  (expires in 60 min)`, note: 'Headless box without a browser? Add --qr to print a QR code you can scan with your phone.' },
  home: { label: 'Home device', text: 'On a Raspberry Pi or NAS with a screen, the link shows on the device. Without a screen, open the device logs or run the CLI over SSH.', cmd: '$ little-dipper claim-link --qr', out: () => 'Scan the QR code with your phone to finish setup', note: 'Anyone who can run a command on the device is treated as the person who deployed it.' },
};

const STEPS = ['Verify link', 'You', 'Sign-in', 'Done'];

function StepPills({ step }: { step: number }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 28 }}>
      {STEPS.map((label, i) => {
        const done = i < step, cur = i === step;
        return (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px 5px 6px', borderRadius: 999, fontSize: 12, background: cur ? 'var(--color-accent-100)' : 'transparent', color: cur ? 'var(--color-accent-800)' : 'var(--color-neutral-700)' }}>
            <span style={{ width: 18, height: 18, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 10, background: done ? 'var(--color-accent-2)' : cur ? 'var(--color-accent)' : 'var(--color-neutral-300)', color: done || cur ? 'var(--color-bg)' : 'var(--color-neutral-700)' }}>{done ? '✓' : i + 1}</span>
            {label}
          </div>
        );
      })}
    </div>
  );
}

export default function Setup() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const nav = useNavigate();
  const toast = useToast();
  const [status, setStatus] = useState<Status | null>(null);
  const [verified, setVerified] = useState<'checking' | 'yes' | 'no'>(token ? 'checking' : 'no');
  const [mode, setMode] = useState<'claim' | 'transfer'>('claim');
  const [step, setStep] = useState(0);
  const [hostTab, setHostTab] = useState<HostTab>('docker');
  const [claimInput, setClaimInput] = useState('');
  const [claimError, setClaimError] = useState(false);
  const [form, setForm] = useState({ name: '', email: '' });
  const [formError, setFormError] = useState('');
  const [passkey, setPasskey] = useState<'idle' | 'pending' | 'done'>('idle');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const tried = useRef(false);

  useEffect(() => {
    get<Status & { hosting: { label: string } }>('/api/v1/node/status').then((s) => {
      setStatus(s);
      const l = s.hosting.label.toLowerCase();
      setHostTab(l.includes('render') ? 'render' : l.includes('docker') ? 'docker' : 'vps');
    });
  }, []);

  // Arrived from the installer: verify the link straight away.
  useEffect(() => {
    if (!token || tried.current) return;
    tried.current = true;
    post<{ mode: 'claim' | 'transfer' }>('/api/v1/node/claim', { token })
      .then((r) => { setMode(r.mode); setVerified('yes'); })
      .catch(() => { setVerified('no'); setClaimError(true); });
  }, [token]);

  if (!status || verified === 'checking') return <div style={{ padding: 48 }}><Loading /></div>;
  if (status.claimed && verified !== 'yes' && step < 3) {
    // Setup is gone for good once claimed (unless this is a transfer link).
    return <Navigate to="/" replace />;
  }

  const nodeAddr = addr(status.address);
  const brand = step > 1 && form.name ? form.name : 'Little Dipper';
  const first = (form.name || 'there').split(' ')[0];
  const host = HOST[hostTab];

  const submitClaim = async () => {
    setBusy(true);
    try {
      const r = await post<{ mode: 'claim' | 'transfer' }>('/api/v1/node/claim', { token: claimInput });
      setMode(r.mode);
      setVerified('yes');
      setStep(1);
    } catch {
      setClaimError(true);
    } finally {
      setBusy(false);
    }
  };

  const saveYou = async () => {
    setFormError('');
    setBusy(true);
    try {
      await post('/api/v1/owner', { displayName: form.name, email: form.email });
      setStep(2);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const createPasskey = async () => {
    setPasskey('pending');
    try {
      const { challengeId, options } = await post('/api/v1/auth/passkeys/register/options');
      const response = await startRegistration({ optionsJSON: options });
      await post('/api/v1/auth/passkeys/register', { challengeId, response, label: 'This device' });
      const r = await post<{ codes: string[] }>('/api/v1/auth/recovery-codes');
      setCodes(r.codes);
      setPasskey('done');
    } catch (e) {
      setPasskey('idle');
      toast((e as Error).name === 'NotAllowedError' ? 'Passkey creation was cancelled' : (e as Error).message);
    }
  };

  const finish = async () => {
    setBusy(true);
    try {
      await post('/api/v1/node/claim/complete');
      setStep(3);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pk = {
    idle: ['var(--color-neutral-300)', 'No passkey yet', 'Your browser will ask to use Face ID, Touch ID, Windows Hello or a security key.'],
    pending: ['var(--color-accent)', 'Waiting for your device…', 'Confirm on your device.'],
    done: ['var(--color-accent-2)', 'Passkey created', 'Saved to “This device”. Add more devices later in Settings.'],
  }[passkey];

  return (
    <div data-screen-label="Unclaimed node" style={{ minHeight: '100%', position: 'relative', overflow: 'hidden', padding: '48px clamp(20px,7vw,96px) 64px' }}>
      <Circle style={{ right: -180, top: -140, width: 520, height: 520, background: 'var(--color-accent-2-200)', opacity: 0.7 }} />
      <Circle style={{ right: 120, top: 260, width: 160, height: 160, background: 'var(--color-accent-200)', opacity: 0.8 }} />
      <div style={{ position: 'relative', maxWidth: 640 }}>
        <div style={{ marginBottom: 36 }}><Brand name={brand} /></div>
        {step > 0 && <StepPills step={step} />}

        {step === 0 && verified === 'yes' && (
          <>
            <span className="tag tag-accent-2">{mode === 'transfer' ? 'Transfer link verified' : 'Claim link verified'}</span>
            <h1 style={{ marginTop: 14, fontSize: 48, textWrap: 'pretty' }}>{mode === 'transfer' ? 'This Little Dipper is being handed to you.' : "Your Little Dipper is ready. Let's make it yours."}</h1>
            <p style={{ fontSize: 17, maxWidth: 540, textWrap: 'pretty' }}>
              Little Dipper is running at <strong>{nodeAddr}</strong>.{' '}
              {mode === 'transfer' ? 'When you finish, the previous owner loses access and you become the owner.' : "You arrived from the installer, so we know you're the person who deployed it."} Setup takes about two minutes.
            </p>
            <p className="text-muted" style={{ fontSize: 14, maxWidth: 540 }}>Want a custom address like yourname.com? You can connect one any time later in Settings.</p>
            <div className="card" style={{ margin: '26px 0', gap: 10, padding: '22px 24px' }}>
              {[['Address', nodeAddr], ['Hosted on', [status.hosting.label, status.hosting.region].filter(Boolean).join(' · ')], ['Version', `Little Dipper ${status.version}`], ['Storage', status.storage]].map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontSize: 14, flexWrap: 'wrap' }}><span className="text-muted">{k}</span><span className="mono" style={{ fontSize: 13 }}>{v}</span></div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <button className="btn btn-primary" onClick={() => setStep(1)} style={{ fontSize: 16, padding: '12px 26px' }}>Set up Little Dipper</button>
              <span className="text-muted" style={{ fontSize: 13 }}>This link works once and expires 1 hour after it was created.</span>
            </div>
          </>
        )}

        {step === 0 && verified === 'no' && (
          <>
            <span className="tag tag-accent">Not set up yet</span>
            <h1 style={{ marginTop: 14, fontSize: 44, textWrap: 'pretty' }}>This Little Dipper is waiting for its owner.</h1>
            <p style={{ fontSize: 17, maxWidth: 540, textWrap: 'pretty' }}>To claim it, open the claim link created when it was installed. Only the person who deployed it can get that link.</p>
            <Pills value={hostTab} onChange={setHostTab} options={Object.entries(HOST).map(([k, h]) => [k as HostTab, h.label])} style={{ margin: '24px 0 14px' }} />
            <div className="card" style={{ padding: '20px 24px', gap: 12 }}>
              <div style={{ fontSize: 14 }}>{host.text}</div>
              <div className="mono" style={{ background: 'var(--color-neutral-900)', color: 'var(--color-neutral-200)', borderRadius: 20, padding: '14px 18px', fontSize: 12.5, lineHeight: 1.7, overflowX: 'auto' }}>
                <div style={{ color: 'var(--color-neutral-400)' }}>{host.cmd}</div>
                <div style={{ color: 'var(--color-accent-300)' }}>{host.out(nodeAddr)}</div>
              </div>
              <div className="text-muted" style={{ fontSize: 12 }}>{host.note}</div>
            </div>
            <div className="field" style={{ marginTop: 20 }}>
              <label htmlFor="claim">Paste your claim link</label>
              <input id="claim" className="input mono" placeholder="https://…/claim?token=…" value={claimInput} onChange={(e) => { setClaimInput(e.target.value); setClaimError(false); }} onKeyDown={(e) => e.key === 'Enter' && submitClaim()} style={{ fontSize: 13, minHeight: 44 }} />
            </div>
            {claimError && <p style={{ color: 'var(--color-accent-700)', fontSize: 13, marginTop: 8 }}>That link isn't valid for this Little Dipper, or it has expired. Generate a fresh one with the command above.</p>}
            <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={busy || !claimInput.trim()} onClick={submitClaim}>Verify and continue</button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h2>Who is this Little Dipper for?</h2>
            <p className="text-muted">This becomes the owner record. Only you can change it later.</p>
            <form onSubmit={(e) => { e.preventDefault(); saveYou(); }} style={{ display: 'grid', gap: 14, maxWidth: 440, marginTop: 20 }}>
              <div className="field"><label htmlFor="n">Your name</label><input id="n" className="input" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
              <div className="field"><label htmlFor="e">Email for recovery and notices</label><input id="e" className="input" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
              {formError && <p style={{ color: 'var(--color-accent-700)', fontSize: 13, margin: 0 }}>{formError}</p>}
              <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setStep(0)}>Back</button>
                <button type="submit" className="btn btn-primary" disabled={busy || !form.name.trim() || !form.email.trim()}>Continue</button>
              </div>
            </form>
          </>
        )}

        {step === 2 && (
          <>
            <h2>Secure your sign-in</h2>
            <p className="text-muted" style={{ maxWidth: 520 }}>A passkey lives on your phone or laptop and can't be phished. Recovery codes get you back in if you lose every device.</p>
            <div className="card" style={{ marginTop: 20, padding: '22px 24px', flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <span style={{ width: 48, height: 48, borderRadius: '50%', background: pk[0], flex: 'none', animation: passkey === 'pending' ? 'ldpulse 1.6s infinite' : undefined }} />
              <div style={{ flex: 1, minWidth: 200 }}><div style={{ fontFamily: 'var(--font-heading)', fontSize: 18 }}>{pk[1]}</div><div className="text-muted" style={{ fontSize: 13 }}>{pk[2]}</div></div>
              {passkey === 'idle' && <button className="btn btn-primary" onClick={createPasskey}>Create passkey</button>}
            </div>
            {passkey === 'done' && (
              <div style={{ marginTop: 22 }}>
                <h5>Recovery codes</h5>
                <div className="mono" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: 8, fontSize: 14, margin: '10px 0 14px' }}>
                  {codes.map((c) => <div key={c} style={{ background: 'var(--color-neutral-100)', borderRadius: 999, padding: '8px 14px', textAlign: 'center' }}>{c}</div>)}
                </div>
                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className="btn btn-secondary" onClick={() => { saveFile('little-dipper-recovery.txt', `Little Dipper recovery codes for ${nodeAddr}\nEach code works once.\n\n${codes.join('\n')}\n`, 'text/plain'); toast('Codes saved as little-dipper-recovery.txt'); }}>Download codes</button>
                  <button role="checkbox" aria-checked={saved} className="bare" onClick={() => setSaved(!saved)} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                    <span style={{ width: 18, height: 18, borderRadius: 6, border: '2px solid var(--color-accent)', background: saved ? 'var(--color-accent)' : 'transparent', color: 'var(--color-bg)', display: 'grid', placeItems: 'center', fontSize: 11 }}>{saved ? '✓' : ''}</span>
                    I've stored these somewhere safe
                  </button>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 28 }}>
              <button className="btn btn-secondary" onClick={() => setStep(1)}>Back</button>
              <button className="btn btn-primary" onClick={finish} disabled={busy || passkey !== 'done' || !saved}>Continue</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <span className="tag tag-accent-2">Claimed</span>
            <h1 style={{ marginTop: 14 }}>Welcome home, {first}.</h1>
            <p style={{ fontSize: 17, maxWidth: 520 }}>You own <strong>{nodeAddr}</strong> with full admin access to every endpoint. The claim link has been destroyed and this setup page is gone for good.</p>
            <div style={{ display: 'grid', gap: 10, margin: '24px 0', maxWidth: 520 }}>
              {['Owner account and passkey created', '8 recovery codes issued', 'Permanent ID created', `Address: ${nodeAddr} · add a custom domain any time in Settings`].map((d) => (
                <div key={d} style={{ display: 'flex', gap: 12, alignItems: 'center', fontSize: 15 }}><span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--color-accent-2)', flex: 'none' }} />{d}</div>
              ))}
            </div>
            <button className="btn btn-primary" onClick={() => nav('/admin', { replace: true })} style={{ fontSize: 16, padding: '12px 26px' }}>Open my dashboard</button>
          </>
        )}
      </div>
    </div>
  );
}
