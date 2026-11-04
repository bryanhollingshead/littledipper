import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, get, post } from '../api';
import { fetchCatalog, type Domain } from '../life';
import { Brand, Circle, Loading, Pills } from '../ui';

/**
 * The consent page an AI assistant sends you to when it connects (OAuth). You choose what it can see, what it can
 * do, which secret details it may read and how long it stays connected, then you're sent back to the assistant.
 */
type Mode = 'answer' | 'suggest' | 'make';
type Length = 'hour' | 'day' | '60d' | 'forever';
type Info = { client: { name: string; uri: string | null; verified: boolean; redirectHost: string }; everyday: string[] };

const MODES: [Mode, string, string][] = [
  ['answer', 'Answer questions', 'It reads what you allow and changes nothing.'],
  ['suggest', 'Suggest changes', 'Its changes wait in Review until you approve them.'],
  ['make', 'Make changes', 'Its changes are saved straight away. You can see and undo them.'],
];
const LENGTHS: [Length, string][] = [['hour', 'Just for now (1 hour)'], ['day', 'For a day'], ['60d', '60 days'], ['forever', 'Until I disconnect']];

export default function Authorize() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const request = useMemo(() => Object.fromEntries(params.entries()), [params]);
  const [info, setInfo] = useState<Info | null>(null);
  const [catalog, setCatalog] = useState<Domain[] | null>(null);
  const [error, setError] = useState('');
  const [preset, setPreset] = useState<'everyday' | 'everything' | 'custom'>('everyday');
  const [kinds, setKinds] = useState<string[]>([]);
  const [documents, setDocuments] = useState(true);
  const [mode, setMode] = useState<Mode>('suggest');
  const [secretFields, setSecretFields] = useState<string[]>([]);
  const [length, setLength] = useState<Length>('60d');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<Info>(`/api/oauth/request?${params.toString()}`)
      .then((i) => { setInfo(i); setKinds(i.everyday); return fetchCatalog().then(setCatalog); })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) nav(`/login?next=${encodeURIComponent(`/oauth/authorize?${params.toString()}`)}`, { replace: true });
        else setError((e as Error).message);
      });
  }, [params, nav]);

  const visible = (catalog ?? []).filter((d) => preset === 'everything' || (preset === 'everyday' ? info?.everyday.includes(d.id) : kinds.includes(d.id)));
  const secrets = visible.flatMap((d) => d.parts.filter((p) => p.sensitivity === 'secret' && !p.deprecated).map((p) => ({ id: `${d.id}.${p.key}`, label: `${d.label}: ${p.label}` })));

  const answer = async (approve: boolean) => {
    setBusy(true);
    setError('');
    try {
      const r = await post<{ redirect: string }>('/api/oauth/authorize', {
        ...request, approve, preset, kinds, documents, length,
        assistant: { mode, secretFields: secretFields.filter((f) => secrets.some((s) => s.id === f)) },
      });
      window.location.assign(r.redirect);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const name = info?.client.name ?? 'An assistant';
  return (
    <div data-screen-label="Connect an assistant" style={{ minHeight: '100%', position: 'relative', overflow: 'hidden', padding: '40px clamp(20px,7vw,96px) 64px' }}>
      <Circle style={{ right: -180, top: -140, width: 520, height: 520, background: 'var(--color-accent-2-200)', opacity: 0.7 }} />
      <div style={{ position: 'relative', maxWidth: 640 }}>
        <div style={{ marginBottom: 28 }}><Brand name="Little Dipper" /></div>
        {error && !info ? (
          <>
            <h1 style={{ fontSize: 36 }}>This connection can’t go ahead</h1>
            <p style={{ fontSize: 16 }}>{error}</p>
          </>
        ) : !info || !catalog ? <Loading /> : (
          <>
            <span className="tag tag-accent">Connect an assistant</span>
            <h1 style={{ marginTop: 14, fontSize: 40, textWrap: 'pretty' }}>{name} wants to connect to your Little Dipper.</h1>
            <p className="text-muted" style={{ fontSize: 14, marginTop: 0 }}>
              “{name}” is the name it gave itself: Little Dipper can’t check it. When you finish, you’ll go back to <strong>{info.client.redirectHost}</strong>. If that isn’t the assistant you were using, don’t connect.
            </p>
            <div className="card" style={{ padding: '14px 18px', gap: 6, marginTop: 8 }}>
              <div style={{ fontSize: 14 }}><strong>What it’s good for:</strong> answering questions from your records, filling in forms, filing documents and keeping things up to date.</div>
              <div style={{ fontSize: 14 }}><strong>Worth knowing:</strong> what it reads leaves your Little Dipper and goes to the company that runs {name}. You can see everything it does, undo its changes, and disconnect it any time.</div>
            </div>

            <h3 style={{ marginTop: 28 }}>What it can see</h3>
            <Pills value={preset} onChange={setPreset} options={[['everyday', 'Everyday'], ['everything', 'Everything'], ['custom', 'Choose']]} />
            <div className="text-muted" style={{ fontSize: 13, marginTop: 8 }}>
              {preset === 'everyday' && 'Addresses, work, education, vehicles, home, insurance, pets, receipts, events and documents. Not IDs, health, money or legal records.'}
              {preset === 'everything' && 'Every kind of record and every document.'}
              {preset === 'custom' && 'Pick the kinds of records it may see.'}
            </div>
            {preset === 'custom' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 4, marginTop: 10 }}>
                {catalog.map((d) => (
                  <label key={d.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={kinds.includes(d.id)} onChange={(e) => setKinds(e.target.checked ? [...kinds, d.id] : kinds.filter((k) => k !== d.id))} />
                    {d.label}
                  </label>
                ))}
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer' }}>
                  <input type="checkbox" checked={documents} onChange={(e) => setDocuments(e.target.checked)} />
                  Documents
                </label>
              </div>
            )}

            <h3 style={{ marginTop: 28 }}>What it can do</h3>
            <div style={{ display: 'grid', gap: 6 }}>
              {MODES.map(([m, label, text]) => (
                <label key={m} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', padding: '10px 14px', borderRadius: 16, border: `1px solid ${mode === m ? 'var(--color-accent)' : 'var(--color-divider)'}`, background: mode === m ? 'var(--color-accent-100)' : 'transparent' }}>
                  <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} style={{ marginTop: 3 }} />
                  <span><span style={{ fontWeight: 600 }}>{label}</span><br /><span className="text-muted" style={{ fontSize: 13 }}>{text}</span></span>
                </label>
              ))}
            </div>

            <h3 style={{ marginTop: 28 }}>Secret details</h3>
            <p className="text-muted" style={{ fontSize: 13, marginTop: 0 }}>Things like ID numbers stay hidden from it unless you tick them here. If it suggests a new one, that always waits for you in Review.</p>
            {secrets.length ? (
              <div style={{ display: 'grid', gap: 4, maxHeight: 180, overflow: 'auto' }}>
                {secrets.map((f) => (
                  <label key={f.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, cursor: 'pointer' }}>
                    <input type="checkbox" checked={secretFields.includes(f.id)} onChange={(e) => setSecretFields(e.target.checked ? [...secretFields, f.id] : secretFields.filter((x) => x !== f.id))} />
                    {f.label}
                  </label>
                ))}
              </div>
            ) : <div className="text-muted" style={{ fontSize: 13 }}>Nothing it can see has secret details.</div>}

            <h3 style={{ marginTop: 28 }}>How long</h3>
            <Pills value={length} onChange={setLength} options={LENGTHS} />
            <p className="text-muted" style={{ fontSize: 12.5 }}>Planning a custom address for your Little Dipper? Set it up first: changing the address later means reconnecting your assistants.</p>

            {error && <p style={{ color: 'var(--color-accent-700)', fontSize: 13 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 12, marginTop: 24, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={busy || (preset === 'custom' && !kinds.length && !documents)} onClick={() => answer(true)} style={{ fontSize: 16, padding: '12px 26px' }}>Connect {name}</button>
              <button className="btn btn-secondary" disabled={busy} onClick={() => answer(false)}>Don’t connect</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
