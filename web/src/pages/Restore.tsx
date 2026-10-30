import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { startRegistration } from '@simplewebauthn/browser';
import { get, post } from '../api';
import { useToast } from '../ui';

type Kit = { format: 'ldkit'; nodeId: string; createdAt?: string };
type Backup = { format: 'ldbackup'; nodeId: string; at: string; documents: number };
type Restored = { nodeId: string; at: string; documents: number; files: number; address: string; movedFrom: string | null };

const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Read a chosen file and check it's the kind we expect, so mistakes show before anything is sent. */
async function readFile<T extends { format: string }>(file: File, format: T['format']): Promise<{ raw: string; meta: T } | null> {
  const raw = await file.text();
  try {
    const meta = JSON.parse(raw) as T;
    return meta?.format === format ? { raw, meta } : null;
  } catch { return null; }
}

/**
 * Restore instead of claim: a fresh Little Dipper becomes the owner's old one, from the recovery
 * kit, its passphrase and a backup file. The story first (what comes back, what you need, what
 * to expect), then the two files, as on the other consent screens.
 */
export default function RestoreFromBackup({ token, nodeAddr, onBack }: { token: string; nodeAddr: string; onBack: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [kit, setKit] = useState<{ name: string; raw: string; meta: Kit } | null>(null);
  const [backup, setBackup] = useState<{ name: string; raw: string; meta: Backup } | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<(Restored & { name: string }) | null>(null);
  const [passkey, setPasskey] = useState<'idle' | 'pending' | 'done'>('idle');

  const pick = (kind: 'kit' | 'backup') => async (file: File | undefined) => {
    setError('');
    if (!file) return;
    if (kind === 'kit') {
      const r = await readFile<Kit>(file, 'ldkit');
      if (!r) return setError(`${file.name} isn’t a recovery kit. It’s the .ldkit file you downloaded in Settings → Address.`);
      setKit({ name: file.name, ...r });
    } else {
      const r = await readFile<Backup>(file, 'ldbackup');
      if (!r) return setError(`${file.name} isn’t a Little Dipper backup. It’s a .ldbackup file from your device or backup folder.`);
      setBackup({ name: file.name, ...r });
    }
  };
  const mismatch = kit && backup && kit.meta.nodeId !== backup.meta.nodeId;

  const restore = async () => {
    if (!kit || !backup) return;
    setBusy(true);
    setError('');
    try {
      const r = await post<Restored>('/api/v1/node/claim/restore', { token, kit: JSON.parse(kit.raw), passphrase, backup: backup.raw });
      const owner = await get<{ displayName: string }>('/api/v1/owner').catch(() => ({ displayName: '' }));
      setDone({ ...r, name: owner.displayName });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addPasskey = async () => {
    setPasskey('pending');
    try {
      const { challengeId, options } = await post('/api/v1/auth/passkeys/register/options');
      const response = await startRegistration({ optionsJSON: options });
      await post('/api/v1/auth/passkeys/register', { challengeId, response, label: 'This device' });
      setPasskey('done');
    } catch (e) {
      setPasskey('idle');
      toast((e as Error).name === 'NotAllowedError' ? 'Passkey creation was cancelled' : (e as Error).message);
    }
  };

  if (done) {
    const first = done.name.split(' ')[0] || 'there';
    return (
      <>
        <span className="tag tag-accent-2">Restored</span>
        <h1 style={{ marginTop: 14 }}>Welcome back, {first}.</h1>
        <p style={{ fontSize: 17, maxWidth: 540 }}>Your Little Dipper is home again, now at <strong>{nodeAddr}</strong>.</p>
        <div style={{ display: 'grid', gap: 10, margin: '24px 0', maxWidth: 540 }}>
          {[
            `Everything from your backup of ${day(done.at)}${done.files ? `, including ${done.files} document ${done.files === 1 ? 'file' : 'files'}` : ''}`,
            'A fresh backup of it, taken on this server just now',
            `The same Little Dipper ID: ${shortId(done.nodeId)}`,
            done.movedFrom ? 'Your connections are being told your new address. They reconnect on their own.' : 'Same address as before',
            'You’re signed in on this device',
          ].map((d) => <Dot key={d}>{d}</Dot>)}
        </div>
        <div className="card" style={{ padding: '22px 24px', gap: 10, maxWidth: 560, background: passkey === 'done' ? 'var(--color-accent-2-100)' : 'var(--color-accent-100)' }}>
          <div className="card-title">{passkey === 'done' ? 'Passkey added' : 'Add a passkey for this address'}</div>
          <div style={{ fontSize: 14 }}>
            {passkey === 'done'
              ? 'You can sign in here with this device from now on.'
              : 'Passkeys belong to a web address, so the one you used before won’t work here. Add one now, or later in Settings → Security. Your recovery codes still work.'}
          </div>
          {passkey !== 'done' && <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={passkey === 'pending'} onClick={addPasskey}>{passkey === 'pending' ? 'Waiting for your device…' : 'Create passkey'}</button>}
        </div>
        <button className={`btn ${passkey === 'done' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => nav('/admin', { replace: true })} style={{ fontSize: 16, padding: '12px 26px', marginTop: 24 }}>Open my dashboard</button>
      </>
    );
  }

  return (
    <>
      <span className="tag tag-accent-2">Claim link verified</span>
      <h1 style={{ marginTop: 14, fontSize: 44, textWrap: 'pretty' }}>Bring your Little Dipper back.</h1>
      <p style={{ fontSize: 17, maxWidth: 560, textWrap: 'pretty' }}>
        If your old server is gone, this one can become it: your data, documents, contacts and connections, with the same ID. You need two things you saved earlier.
      </p>

      <div style={{ display: 'grid', gap: 12, margin: '22px 0', maxWidth: 560 }}>
        <FilePick n={1} title="Your recovery kit" hint="The .ldkit file from Settings → Address, and the passphrase you chose for it."
          chosen={kit && `${kit.name} · Little Dipper ${shortId(kit.meta.nodeId)}`} accept=".ldkit,application/json" onPick={pick('kit')}>
          <input className="input" type="password" autoComplete="off" placeholder="Recovery kit passphrase" aria-label="Recovery kit passphrase" value={passphrase}
            onChange={(e) => { setPassphrase(e.target.value); setError(''); }} style={{ marginTop: 10 }} />
        </FilePick>
        <FilePick n={2} title="A backup" hint="A .ldbackup file from your Downloads or the backup folder you chose. The newest is best."
          chosen={backup && `${backup.name} · taken ${day(backup.meta.at)}`} accept=".ldbackup,application/json" onPick={pick('backup')} />
      </div>

      <div style={{ maxWidth: 560, fontSize: 13, display: 'grid', gap: 6 }}>
        <div className="card-kicker" style={{ color: 'var(--color-neutral-700)' }}>Things to know</div>
        <Dot>Your connections are told your new address and reconnect on their own. No new invites.</Dot>
        <Dot>Passkeys belong to a web address. You’ll be signed in here and asked to add a new one.</Dot>
        <Dot>Nothing changes on this server until every check passes.</Dot>
      </div>

      {mismatch && <p style={{ color: 'var(--color-accent-700)', fontSize: 13, marginTop: 16 }}>This kit and this backup are from different Little Dippers. Pick the backup that belongs to this kit.</p>}
      {error && <p style={{ color: 'var(--color-accent-700)', fontSize: 13, marginTop: 16, maxWidth: 560 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 10, marginTop: 22, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-secondary" onClick={onBack} disabled={busy}>Back</button>
        <button className="btn btn-primary" disabled={busy || !kit || !backup || !passphrase || !!mismatch} onClick={restore} style={{ fontSize: 16, padding: '12px 26px' }}>
          {busy ? 'Restoring…' : 'Restore my Little Dipper'}
        </button>
        {busy && <span className="text-muted" style={{ fontSize: 13 }}>A large backup can take a minute.</span>}
      </div>
    </>
  );
}

function FilePick({ n, title, hint, chosen, accept, onPick, children }: { n: number; title: string; hint: string; chosen: string | null | false; accept: string; onPick: (f: File | undefined) => void; children?: ReactNode }) {
  return (
    <div className="card" style={{ padding: '18px 20px', gap: 4, background: chosen ? 'var(--color-accent-2-100)' : undefined }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{ width: 28, height: 28, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 600, background: chosen ? 'var(--color-accent-2)' : 'var(--color-accent)', color: 'var(--color-bg)' }}>{chosen ? '✓' : n}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="card-title">{title}</div>
          <div className="text-muted" style={{ fontSize: 13 }}>{chosen || hint}</div>
          <label className="btn btn-secondary" style={{ marginTop: 10, fontSize: 13 }}>
            {chosen ? 'Choose a different file' : 'Choose file'}
            <input type="file" accept={accept} hidden onChange={(e) => onPick(e.target.files?.[0])} />
          </label>
          {children}
        </div>
      </div>
    </div>
  );
}

const Dot = ({ children }: { children: ReactNode }) => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-accent-2)', flex: 'none', transform: 'translateY(-1px)' }} /><span>{children}</span></div>
);
