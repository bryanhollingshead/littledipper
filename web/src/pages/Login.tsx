import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { startAuthentication } from '@simplewebauthn/browser';
import { addr, get, post } from '../api';
import { Brand, Circle, useToast } from '../ui';

export default function Login() {
  const nav = useNavigate();
  const toast = useToast();
  const [status, setStatus] = useState<{ address: string; claimed: boolean } | null>(null);
  const [brand, setBrand] = useState('Little Dipper');
  const [mode, setMode] = useState<'passkey' | 'pw' | 'recovery'>('passkey');
  const [pending, setPending] = useState(false);
  const [f, setF] = useState({ pw: '', totp: '', code: '' });
  const [error, setError] = useState('');

  useEffect(() => {
    get('/api/v1/node/status').then((s) => (s.claimed ? setStatus(s) : nav('/', { replace: true })));
    get('/.well-known/little-dipper').then((d) => d.displayName && setBrand(d.displayName)).catch(() => {});
    get('/api/v1/owner').then(() => nav('/admin', { replace: true })).catch(() => {});
  }, [nav]);

  const done = () => nav('/admin', { replace: true });

  const passkey = async () => {
    setPending(true);
    setError('');
    try {
      const { challengeId, options } = await post('/api/v1/auth/passkeys/options');
      const response = await startAuthentication({ optionsJSON: options });
      await post('/api/v1/auth/passkeys/verify', { challengeId, response });
      done();
    } catch (e) {
      if ((e as Error).name !== 'NotAllowedError') setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };

  const password = async () => {
    setError('');
    try {
      await post('/api/v1/auth/password', { password: f.pw });
      await post('/api/v1/auth/totp/verify', { code: f.totp });
      done();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const recovery = async () => {
    setError('');
    try {
      const r = await post('/api/v1/auth/recovery', { code: f.code });
      toast(`Signed in. ${r.codesLeft} recovery code${r.codesLeft === 1 ? '' : 's'} left.`);
      done();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div data-screen-label="Sign in" style={{ minHeight: '100%', position: 'relative', overflow: 'hidden', padding: '64px clamp(20px,7vw,96px)' }}>
      <Circle style={{ right: -120, bottom: -160, width: 480, height: 480, background: 'var(--color-accent-200)', opacity: 0.7 }} />
      <div style={{ position: 'relative', maxWidth: 420 }}>
        <div style={{ marginBottom: 48 }}><Brand name={brand} /></div>
        <h1>Sign in</h1>
        <p className="text-muted">Owner access to <strong style={{ color: 'var(--color-text)' }}>{status ? addr(status.address) : '…'}</strong></p>

        {mode === 'passkey' && (
          <>
            <button className="btn btn-primary" onClick={passkey} disabled={pending} style={{ width: '100%', fontSize: 16, padding: 14, marginTop: 24 }}>{pending ? 'Waiting for your device…' : 'Sign in with passkey'}</button>
            <button className="btn btn-ghost" onClick={() => { setMode('pw'); setError(''); }} style={{ marginTop: 14 }}>Use password and authenticator code</button>
          </>
        )}

        {mode === 'pw' && (
          <form onSubmit={(e) => { e.preventDefault(); password(); }} style={{ display: 'grid', gap: 14, marginTop: 24 }}>
            <div className="field"><label htmlFor="pw">Password</label><input id="pw" className="input" type="password" autoComplete="current-password" value={f.pw} onChange={(e) => setF({ ...f, pw: e.target.value })} /></div>
            <div className="field"><label htmlFor="totp">6-digit code from your authenticator</label><input id="totp" className="input mono" inputMode="numeric" autoComplete="one-time-code" value={f.totp} onChange={(e) => setF({ ...f, totp: e.target.value })} placeholder="000 000" style={{ letterSpacing: '.2em', fontSize: 18 }} /></div>
            <button type="submit" className="btn btn-primary" style={{ padding: 12 }}>Sign in</button>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-ghost" onClick={() => { setMode('passkey'); setError(''); }}>Use a passkey</button>
              <button type="button" className="btn btn-ghost" onClick={() => { setMode('recovery'); setError(''); }}>Use a recovery code</button>
            </div>
          </form>
        )}

        {mode === 'recovery' && (
          <form onSubmit={(e) => { e.preventDefault(); recovery(); }} style={{ display: 'grid', gap: 14, marginTop: 24 }}>
            <div className="field"><label htmlFor="rc">Recovery code</label><input id="rc" className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="XXXX-XXXX" style={{ letterSpacing: '.1em', fontSize: 18 }} /></div>
            <button type="submit" className="btn btn-primary" style={{ padding: 12 }}>Sign in</button>
            <div className="text-muted" style={{ fontSize: 12 }}>Each code works once. Add a new passkey in Settings once you're in.</div>
            <button type="button" className="btn btn-ghost" onClick={() => { setMode('passkey'); setError(''); }} style={{ justifySelf: 'start' }}>Use a passkey</button>
          </form>
        )}

        {error && <p style={{ color: 'var(--color-accent-700)', fontSize: 13, marginTop: 14 }}>{error}</p>}
        <p className="text-muted" style={{ fontSize: 12, marginTop: 40 }}>Not the owner? <Link to="/">View the public profile</Link></p>
      </div>
    </div>
  );
}
