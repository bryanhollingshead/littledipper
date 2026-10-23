/** Contacts banner and connect dialog for Big Dipper: one connection, separate opt-in services. All text comes from the API. */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, put } from '../../api';
import { Dialog, Toggle, useAction, useAsync } from '../../ui';

type Service = { key: string; title: string; tagline: string; forYou: string[]; forOthers: string[]; sees: string };
type BigDipper = {
  available: boolean; url: string | null; address: string | null;
  contact: { contactId: string; status: string } | null;
  chosen: string[]; upgrades: string; choseAt: string | null;
  services: Service[];
  upgradeModes: { key: string; title: string; text: string }[];
  promises: string[];
};

const HIDE_KEY = 'ld.contacts.bigDipperHidden';
function readHidden() {
  try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; }
}
function writeHidden(v: boolean) {
  try { v ? localStorage.setItem(HIDE_KEY, '1') : localStorage.removeItem(HIDE_KEY); } catch { /* fine: just not remembered */ }
}

/** The Big Dipper's seven stars: handle to bowl. */
const STARS: [number, number, number][] = [[6, 10, 2.2], [44, 22, 2.6], [78, 28, 2.6], [110, 40, 2.2], [114, 78, 2.6], [168, 82, 3], [174, 34, 3]];
function Dipper() {
  const line = STARS.map(([x, y]) => `${x},${y}`).join(' ') + ` ${STARS[3][0]},${STARS[3][1]}`;
  return (
    <svg aria-hidden width="190" height="100" viewBox="0 0 190 100" style={{ position: 'absolute', right: 24, top: 18, opacity: 0.9 }}>
      <polyline points={line} fill="none" stroke="var(--color-accent-400)" strokeWidth="1" strokeDasharray="2 4" opacity=".7" />
      {STARS.map(([x, y, r]) => <g key={x}><circle cx={x} cy={y} r={r * 3} fill="var(--color-accent-300)" opacity=".12" /><circle cx={x} cy={y} r={r} fill="var(--color-neutral-100)" /></g>)}
    </svg>
  );
}

const ICON: Record<string, ReactNode> = {
  interface: <path d="M8 7 3 12l5 5M16 7l5 5-5 5M13.5 5l-3 14" />,
  upgrades: <><path d="M12 19V5M6 11l6-6 6 6" /><path d="M5 21h14" /></>,
  identity: <><path d="M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6z" /><path d="m9 12 2 2 4-4" /></>,
};
const ServiceIcon = ({ k, color }: { k: string; color: string }) => (
  <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: 1 }}>{ICON[k]}</svg>
);

export default function BigDipperBanner() {
  const nav = useNavigate();
  const [hidden, setHidden] = useState(readHidden);
  const [open, setOpen] = useState(false);
  const { data: bd, reload } = useAsync(() => get<BigDipper>('/api/v1/big-dipper'), []);

  if (!bd || bd.contact?.status === 'active') return null;
  if (hidden) {
    return <button className="bare text-muted" style={{ fontSize: 12, marginTop: 14, textDecoration: 'underline' }} onClick={() => { writeHidden(false); setHidden(false); }}>About Big Dipper services</button>;
  }
  const names = bd.chosen.map((k) => bd.services.find((s) => s.key === k)?.title).filter(Boolean);

  return (
    <>
    <section aria-label="Big Dipper" className="card" style={{ marginTop: 22, padding: '24px 26px', gap: 18, background: 'var(--color-neutral-900)', color: 'var(--color-neutral-100)', position: 'relative', overflow: 'hidden' }}>
      <div aria-hidden style={{ position: 'absolute', right: -80, bottom: -120, width: 280, height: 280, borderRadius: '50%', background: 'var(--color-accent-800)', opacity: 0.6 }} />
      <Dipper />
      <div style={{ position: 'relative', maxWidth: 600 }}>
        <div className="card-kicker" style={{ color: 'var(--color-accent-300)' }}>Big Dipper · optional</div>
        <div className="card-title" style={{ fontSize: 22, marginTop: 4 }}>Add Big Dipper as a contact</div>
        <div style={{ fontSize: 14, color: 'var(--color-neutral-400)', marginTop: 6, textWrap: 'pretty' }}>
          Big Dipper is the companion service for Little Dipper. Connect once, then choose which services you want. Each one is separate, and you can turn any of them off.
        </div>
      </div>

      <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 10 }}>
        {bd.services.map((s) => (
          <div key={s.key} style={{ display: 'flex', gap: 12, padding: '14px 16px', borderRadius: 18, background: 'color-mix(in srgb, var(--color-neutral-100) 7%, transparent)' }}>
            <ServiceIcon k={s.key} color="var(--color-accent-300)" />
            <div><div style={{ fontWeight: 600, fontSize: 14 }}>{s.title}{bd.chosen.includes(s.key) && <span style={{ color: 'var(--color-accent-2-300)', fontWeight: 400 }}> · chosen</span>}</div><div style={{ fontSize: 13, color: 'var(--color-neutral-400)', marginTop: 3, lineHeight: 1.45 }}>{s.tagline}</div></div>
          </div>
        ))}
      </div>

      <div style={{ position: 'relative', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {bd.contact
          ? <button className="btn btn-primary" style={{ background: 'var(--color-accent-2-600)' }} onClick={() => nav(`/admin/contacts/${bd.contact!.contactId}`)}>Request sent · view</button>
          : <button className="btn btn-primary" style={{ background: 'var(--color-accent-2-600)' }} onClick={() => setOpen(true)}>{names.length ? 'Review your choices' : 'Choose services'}</button>}
        <button className="btn btn-ghost" style={{ color: 'var(--color-neutral-400)', marginLeft: 'auto' }} onClick={() => { writeHidden(true); setHidden(true); }}>Not now</button>
        {!bd.available && names.length > 0 && !bd.contact && <span style={{ fontSize: 12, color: 'var(--color-neutral-400)', width: '100%' }}>Big Dipper isn’t open yet. We saved your choices ({names.join(', ')}). Connecting will take one click once it opens.</span>}
      </div>
    </section>
    {open && <ConnectDialog bd={bd} onClose={() => setOpen(false)} onDone={() => { setOpen(false); reload(); }} />}
    </>
  );
}

function ConnectDialog({ bd, onClose, onDone }: { bd: BigDipper; onClose: () => void; onDone: () => void }) {
  const nav = useNavigate();
  const { run, busy } = useAction();
  const [chosen, setChosen] = useState<string[]>(bd.chosen.length ? bd.chosen : bd.services.map((s) => s.key));
  const [upgrades, setUpgrades] = useState(bd.upgrades);
  const [step, setStep] = useState<'choose' | 'review'>('choose');
  const flip = (k: string) => setChosen((c) => (c.includes(k) ? c.filter((x) => x !== k) : [...c, k]));
  const picked = bd.services.filter((s) => chosen.includes(s.key));

  const finish = async () => {
    const body = { services: chosen, upgrades };
    if (!bd.available) {
      if (await run(() => put('/api/v1/big-dipper', body), 'Choices saved')) onDone();
      return;
    }
    const r = await run(() => post<{ contactId: string }>('/api/v1/big-dipper/connect', body), 'Request sent to Big Dipper');
    if (r) { onDone(); nav(`/admin/contacts/${r.contactId}`); }
  };

  return (
    <Dialog width={680} onClose={onClose} title={step === 'choose' ? 'Choose Big Dipper services' : 'Before you connect'} actions={step === 'choose' ? <>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={!chosen.length} onClick={() => setStep('review')}>Continue</button>
    </> : <>
      <button className="btn btn-secondary" onClick={() => setStep('choose')}>Back</button>
      <button className="btn btn-primary" disabled={busy} onClick={finish}>{bd.available ? 'Send connection request' : 'Save my choices'}</button>
    </>}>
      {step === 'choose' ? (
        <div className="dialog-body" style={{ opacity: 1, display: 'grid', gap: 12 }}>
          <div className="text-muted" style={{ fontSize: 13 }}>Pick any or all. You can change this later.</div>
          {bd.services.map((s) => {
            const on = chosen.includes(s.key);
            return (
              <div key={s.key} style={{ border: `1px solid ${on ? 'var(--color-accent-2-400)' : 'var(--color-divider)'}`, background: on ? 'var(--color-accent-2-100)' : 'transparent', borderRadius: 20, padding: '16px 18px', display: 'grid', gap: 12, transition: 'background .15s, border-color .15s' }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <ServiceIcon k={s.key} color="var(--color-accent-2-700)" />
                  <div style={{ flex: 1 }}><div style={{ fontWeight: 600 }}>{s.title}</div><div className="text-muted" style={{ fontSize: 13 }}>{s.tagline}</div></div>
                  <Toggle on={on} onChange={() => flip(s.key)} label={s.title} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 14, fontSize: 13 }}>
                  <Benefits title="For you" items={s.forYou} />
                  <Benefits title="For people who rely on you" items={s.forOthers} />
                </div>
                {s.key === 'upgrades' && on && (
                  <div role="radiogroup" aria-label="How upgrades install" style={{ display: 'grid', gap: 6 }}>
                    {bd.upgradeModes.map((m) => (
                      <label key={m.key} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', fontSize: 13, cursor: 'pointer' }}>
                        <input type="radio" name="upgrades" checked={upgrades === m.key} onChange={() => setUpgrades(m.key)} style={{ marginTop: 3 }} />
                        <span><b style={{ fontWeight: 600 }}>{m.title}</b> <span className="text-muted">{m.text}</span></span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="dialog-body" style={{ opacity: 1, display: 'grid', gap: 16 }}>
          <div>
            <h4 style={{ margin: '0 0 8px' }}>What Big Dipper can see</h4>
            <div style={{ display: 'grid', gap: 8 }}>
              {picked.map((s) => (
                <div key={s.key} style={{ display: 'flex', gap: 10, fontSize: 13 }}>
                  <ServiceIcon k={s.key} color="var(--color-accent-2-700)" />
                  <div><b style={{ fontWeight: 600 }}>{s.title}{s.key === 'upgrades' ? ` · ${bd.upgradeModes.find((m) => m.key === upgrades)?.title.toLowerCase()}` : ''}.</b> {s.sees}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h4 style={{ margin: '0 0 8px' }}>Your terms</h4>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: 'grid', gap: 6 }}>{bd.promises.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
          {!bd.available && <div style={{ fontSize: 13, padding: '12px 14px', borderRadius: 14, background: 'var(--color-accent-100)', color: 'var(--color-accent-800)' }}>Big Dipper isn’t open yet. We’ll save these choices on your Little Dipper so connecting later takes one click.</div>}
        </div>
      )}
    </Dialog>
  );
}

const Benefits = ({ title, items }: { title: string; items: string[] }) => (
  <div>
    <div className="text-muted" style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 4 }}>{title}</div>
    <ul style={{ margin: 0, paddingLeft: 16, display: 'grid', gap: 3 }}>{items.map((x) => <li key={x}>{x}</li>)}</ul>
  </div>
);
