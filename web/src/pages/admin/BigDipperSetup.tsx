/** Settings → Big Dipper: what the companion service offers, what to know, and the owner's choices. All text comes from the API. */
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, put } from '../../api';
import { Loading, Toggle, useAction, useAsync } from '../../ui';

type Option = { key: string; title: string; text: string; requires?: { setting: string; values: string[] } };
type Setting = { key: string; label: string; help?: string; options: Option[]; default: string; showWhen?: { setting: string; values: string[] } };
type Service = { key: string; title: string; tagline: string; forYou: string[]; forOthers: string[]; thingsToKnow: string[]; price?: string; settings: Setting[] };
export type BigDipper = {
  available: boolean; url: string | null; address: string | null;
  contact: { contactId: string; status: string } | null;
  chosen: string[]; settings: Record<string, string>; choseAt: string | null;
  detectedHosting: { key: string; label: string };
  hostingNotes: Record<string, string>;
  services: Service[];
  boundaries: { key: string; title: string; text: string }[];
  journey: { title: string; text: string }[];
};

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const GLYPH: Record<string, ReactNode> = {
  interface: <path d="M8 7 3 12l5 5M16 7l5 5-5 5M13.5 5l-3 14" />,
  upgrades: <><path d="M12 17V5M7 10l5-5 5 5" /><path d="M5 20h14" /></>,
  identity: <><path d="M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6z" /><path d="m9 12 2 2 4-4" /></>,
  nothing: <><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" /><circle cx="12" cy="12" r="2.5" /><path d="M4 4l16 16" /></>,
  keys: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M16 7l2 2M14 9l1.5 1.5" /></>,
  ask: <><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z" /><path d="M10 9a2 2 0 1 1 2.5 1.9c-.3.1-.5.4-.5.7v.4M12 14h.01" /></>,
  leave: <><path d="M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" /><path d="M10 8l-4 4 4 4M6 12h10" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  price: <><path d="M3.5 12.5 11 5h7a1 1 0 0 1 1 1v7l-7.5 7.5a1.4 1.4 0 0 1-2 0l-6-6a1.4 1.4 0 0 1 0-2z" /><circle cx="15" cy="9" r="1.4" /></>,
};
const Glyph = ({ k, size = 22, color }: { k: string; size?: number; color?: string }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" {...stroke} style={{ flex: 'none', color }}>{GLYPH[k]}</svg>
);

/** The Big Dipper's seven stars: handle to bowl. */
const STARS: [number, number, number][] = [[6, 10, 2.2], [44, 22, 2.6], [78, 28, 2.6], [110, 40, 2.2], [114, 78, 2.6], [168, 82, 3], [174, 34, 3]];
export function Dipper({ style }: { style?: React.CSSProperties }) {
  const line = STARS.map(([x, y]) => `${x},${y}`).join(' ') + ` ${STARS[3][0]},${STARS[3][1]}`;
  return (
    <svg aria-hidden width="190" height="100" viewBox="0 0 190 100" style={{ position: 'absolute', ...style }}>
      <polyline points={line} fill="none" stroke="var(--color-accent-400)" strokeWidth="1" strokeDasharray="2 4" opacity=".7" />
      {STARS.map(([x, y, r]) => <g key={x}><circle cx={x} cy={y} r={r * 3} fill="var(--color-accent-300)" opacity=".12" /><circle cx={x} cy={y} r={r} fill="var(--color-neutral-100)" /></g>)}
    </svg>
  );
}

export default function BigDipperSetup() {
  const nav = useNavigate();
  const { run, busy } = useAction();
  const { data: bd, reload } = useAsync(() => get<BigDipper>('/api/v1/big-dipper'), []);
  const [chosen, setChosen] = useState<string[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  useEffect(() => { if (bd) { setChosen(bd.chosen); setSettings(bd.settings); } }, [bd]);
  if (!bd) return <Loading />;

  const dirty = JSON.stringify([[...chosen].sort(), settings]) !== JSON.stringify([[...bd.chosen].sort(), bd.settings]);
  const connected = bd.contact?.status === 'active';
  const pending = !!bd.contact && !connected;
  const flip = (k: string) => setChosen((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));
  const allowed = (o: Option, v = settings) => !o.requires || o.requires.values.includes(v[o.requires.setting]);
  const set = (key: string, value: string) => setSettings((cur) => {
    const next = { ...cur, [key]: value };
    // A hosting change can rule out the chosen option elsewhere: fall back to that setting's default.
    for (const st of bd.services.flatMap((s) => s.settings)) {
      const o = st.options.find((x) => x.key === next[st.key]);
      if (o && !allowed(o, next)) next[st.key] = st.default;
    }
    return next;
  });
  const body = { services: chosen, settings };
  const save = async () => { if (await run(() => put('/api/v1/big-dipper', body), 'Choices saved')) reload(); };
  const connect = async () => {
    const r = await run(() => post<{ contactId: string }>('/api/v1/big-dipper/connect', body), 'Request sent to Big Dipper');
    if (r) { reload(); nav(`/admin/contacts/${r.contactId}`); }
  };

  const status = connected ? ['Connected', 'var(--color-accent-2-300)'] : pending ? ['Request sent', 'var(--color-accent-300)'] : bd.available ? ['Not connected', 'var(--color-neutral-400)'] : ['Opening soon', 'var(--color-accent-300)'];

  return (
    <div style={{ display: 'grid', gap: 28, paddingBottom: 8 }}>
      {/* Hero */}
      <section className="card" style={{ padding: 'clamp(24px, 4vw, 36px)', gap: 14, background: 'var(--color-neutral-900)', color: 'var(--color-neutral-100)', position: 'relative', overflow: 'hidden' }}>
        <div aria-hidden style={{ position: 'absolute', right: -90, bottom: -150, width: 340, height: 340, borderRadius: '50%', background: 'var(--color-accent-800)', opacity: 0.6 }} />
        <div aria-hidden style={{ position: 'absolute', right: 230, bottom: -70, width: 130, height: 130, borderRadius: '50%', background: 'var(--color-accent-2-800)', opacity: 0.5 }} />
        <Dipper style={{ right: 28, top: 26 }} />
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="card-kicker" style={{ color: 'var(--color-accent-300)' }}>Optional companion service</span>
          <span style={{ fontSize: 11, padding: '3px 10px', borderRadius: 999, border: `1px solid ${status[1]}`, color: status[1] }}>{status[0]}</span>
        </div>
        <h2 style={{ position: 'relative', margin: 0, fontSize: 'clamp(30px, 4vw, 40px)', lineHeight: 1.05, maxWidth: 520 }}>A helping hand for your own server. You stay in charge.</h2>
        <p style={{ position: 'relative', margin: 0, fontSize: 15, color: 'var(--color-neutral-400)', maxWidth: 560, lineHeight: 1.55, textWrap: 'pretty' }}>
          Big Dipper can keep an eye on your Little Dipper, help keep it up to date and vouch for who you are. You choose what it does. It never gets the keys.
        </p>
      </section>

      {/* Boundaries */}
      <section aria-labelledby="bd-bounds">
        <h3 id="bd-bounds" style={{ margin: '0 0 12px' }}>The boundaries</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 200px), 1fr))', gap: 12 }}>
          {bd.boundaries.map((b) => (
            <div key={b.key} className="card" style={{ padding: '18px 18px 16px', gap: 8 }}>
              <span style={{ width: 38, height: 38, borderRadius: 12, background: 'var(--color-accent-100)', color: 'var(--color-accent-700)', display: 'grid', placeItems: 'center' }}><Glyph k={b.key} size={20} /></span>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{b.title}</div>
              <div className="text-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{b.text}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Services */}
      <section aria-labelledby="bd-services" style={{ display: 'grid', gap: 14 }}>
        <div>
          <h3 id="bd-services" style={{ margin: 0 }}>Choose what Big Dipper does for you</h3>
          <p className="text-muted" style={{ margin: '4px 0 0', fontSize: 14 }}>Any, all or none. Each one is separate, and you can change your mind later.</p>
        </div>
        {bd.services.map((s) => {
          const on = chosen.includes(s.key);
          return (
            <article key={s.key} className="card" style={{ padding: 0, gap: 0, overflow: 'hidden', outline: on ? '2px solid var(--color-accent-2-400)' : '2px solid transparent', transition: 'outline-color .15s' }}>
              <header style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '18px 22px', background: on ? 'var(--color-accent-2-100)' : 'transparent', transition: 'background .15s' }}>
                <span style={{ width: 44, height: 44, borderRadius: 14, background: on ? 'var(--color-accent-2-600)' : 'var(--color-neutral-200)', color: on ? 'var(--color-bg)' : 'var(--color-neutral-700)', display: 'grid', placeItems: 'center', transition: 'background .15s, color .15s' }}><Glyph k={s.key} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: 'var(--font-heading)', fontSize: 20, lineHeight: 1.2 }}>{s.title}</div>
                  <div className="text-muted" style={{ fontSize: 14 }}>{s.tagline}</div>
                </div>
                <span className="text-muted" style={{ fontSize: 12 }}>{on ? 'On' : 'Off'}</span>
                <Toggle on={on} onChange={() => flip(s.key)} label={s.title} />
              </header>
              <div style={{ padding: '18px 22px 22px', display: 'grid', gap: 18 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 18 }}>
                  <Points title="For you" items={s.forYou} />
                  <Points title="For people who rely on you" items={s.forOthers} />
                </div>
                <div style={{ borderRadius: 16, background: 'var(--color-neutral-100)', border: '1px solid var(--color-divider)', padding: '14px 16px', display: 'flex', gap: 12 }}>
                  <Glyph k="info" size={18} color="var(--color-accent-600)" />
                  <div style={{ display: 'grid', gap: 6 }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>Things to know</div>
                    {s.thingsToKnow.map((t) => <div key={t} style={{ fontSize: 13, lineHeight: 1.5 }}>{t}</div>)}
                  </div>
                </div>
                {s.price && (
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', fontSize: 13 }}>
                    <Glyph k="price" size={18} color="var(--color-accent-2-700)" />
                    <div><b style={{ fontWeight: 600 }}>Cost.</b> {s.price}</div>
                  </div>
                )}
                {on && s.settings.filter((st) => !st.showWhen || st.showWhen.values.includes(settings[st.showWhen.setting])).map((st) => (
                  <fieldset key={st.key} style={{ border: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                    <legend style={{ fontWeight: 600, fontSize: 14, padding: 0, marginBottom: 2 }}>{st.label}</legend>
                    {st.help && <div className="text-muted" style={{ fontSize: 12, marginTop: -4 }}>{st.help}</div>}
                    <div role="radiogroup" aria-label={st.label} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 180px), 1fr))', gap: 8 }}>
                      {st.options.map((o) => {
                        const sel = settings[st.key] === o.key;
                        const ok = allowed(o);
                        const detected = st.key === 'upgrades.hosting' && o.key === bd.detectedHosting.key && o.key !== 'unsure';
                        return (
                          <button key={o.key} type="button" role="radio" aria-checked={sel} disabled={!ok} onClick={() => set(st.key, o.key)} className="bare"
                            title={ok ? undefined : 'Not available with how your Little Dipper is hosted'}
                            style={{ padding: '12px 14px', borderRadius: 14, border: `1.5px solid ${sel ? 'var(--color-accent-2-600)' : 'var(--color-divider)'}`, background: sel ? 'var(--color-accent-2-100)' : 'var(--color-bg)', opacity: ok ? 1 : 0.45, cursor: ok ? 'pointer' : 'not-allowed', display: 'grid', gap: 2, transition: 'border-color .12s, background .12s' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, fontSize: 13 }}>
                              <span aria-hidden style={{ width: 14, height: 14, borderRadius: '50%', border: `1.5px solid ${sel ? 'var(--color-accent-2-600)' : 'var(--color-neutral-400)'}`, boxShadow: sel ? 'inset 0 0 0 3px var(--color-bg)' : undefined, background: sel ? 'var(--color-accent-2-600)' : 'transparent', flex: 'none' }} />
                              {o.title}
                            </span>
                            <span className="text-muted" style={{ fontSize: 12, paddingLeft: 22 }}>{ok ? o.text : 'Not available with your hosting'}</span>
                            {detected && <span style={{ fontSize: 11, color: 'var(--color-accent-2-700)', paddingLeft: 22 }}>Looks like yours ({bd.detectedHosting.label})</span>}
                          </button>
                        );
                      })}
                    </div>
                    {st.key === 'upgrades.hosting' && <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--color-accent-800)', background: 'var(--color-accent-100)', borderRadius: 12, padding: '10px 14px' }}>{bd.hostingNotes[settings[st.key]]}</div>}
                  </fieldset>
                ))}
              </div>
            </article>
          );
        })}
      </section>

      {/* Journey */}
      <section aria-labelledby="bd-how">
        <h3 id="bd-how" style={{ margin: '0 0 14px' }}>How it works</h3>
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 190px), 1fr))', gap: 16 }}>
          {bd.journey.map((j, i) => (
            <li key={j.title} style={{ display: 'grid', gap: 6, position: 'relative' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ width: 28, height: 28, borderRadius: '50%', background: i === 0 ? 'var(--color-accent)' : 'var(--color-accent-200)', color: i === 0 ? 'var(--color-bg)' : 'var(--color-accent-800)', display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 600, flex: 'none' }}>{i + 1}</span>
                <span aria-hidden style={{ flex: 1, height: 1, background: i < bd.journey.length - 1 ? 'var(--color-neutral-300)' : 'transparent' }} />
              </span>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{j.title}</span>
              <span className="text-muted" style={{ fontSize: 13, lineHeight: 1.5 }}>{j.text}</span>
            </li>
          ))}
        </ol>
      </section>

      {/* Decision bar */}
      <div style={{ position: 'sticky', bottom: 12, zIndex: 5 }}>
        <div className="card" style={{ padding: '14px 18px', flexDirection: 'row', alignItems: 'center', gap: 14, flexWrap: 'wrap', boxShadow: '0 10px 30px -12px color-mix(in srgb, var(--color-neutral-900) 35%, transparent)', background: 'var(--color-bg)', border: '1px solid var(--color-divider)' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {chosen.length ? `${chosen.length} service${chosen.length === 1 ? '' : 's'} chosen` : 'No services chosen'}
              {dirty && <span className="text-muted" style={{ fontWeight: 400 }}> · unsaved changes</span>}
            </div>
            <div className="text-muted" style={{ fontSize: 12 }}>
              {connected ? 'You’re connected. Changes apply once Big Dipper confirms them.'
                : pending ? 'Your request is waiting for Big Dipper.'
                : bd.available ? 'Nothing has been sent. Connecting shares your address and node ID only.'
                : 'Big Dipper isn’t open yet. Your choices stay on your Little Dipper, and nothing is sent.'}
            </div>
          </div>
          {pending && <button className="btn btn-secondary" onClick={() => nav(`/admin/contacts/${bd.contact!.contactId}`)}>View request</button>}
          {(dirty || !bd.available || connected || pending) && <button className="btn btn-secondary" disabled={busy || !dirty} onClick={save}>Save choices</button>}
          {bd.available && !bd.contact && <button className="btn btn-primary" style={{ background: 'var(--color-accent-2-600)' }} disabled={busy || !chosen.length} onClick={connect}>Connect with Big Dipper</button>}
        </div>
      </div>
    </div>
  );
}

const Points = ({ title, items }: { title: string; items: string[] }) => (
  <div>
    <div className="text-muted" style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 6 }}>{title}</div>
    <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
      {items.map((x) => (
        <li key={x} style={{ display: 'flex', gap: 8, fontSize: 14, lineHeight: 1.45 }}>
          <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" {...stroke} strokeWidth={2.2} style={{ flex: 'none', marginTop: 2, color: 'var(--color-accent-2-600)' }}><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
          <span>{x}</span>
        </li>
      ))}
    </ul>
  </div>
);
