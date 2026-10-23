/** Contacts banner: introduces Big Dipper and leads to its setup page under Settings. Text for services comes from the API. */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../../api';
import { useAsync } from '../../ui';
import { Dipper, type BigDipper } from './BigDipperSetup';

const HIDE_KEY = 'ld.contacts.bigDipperHidden';
function readHidden() {
  try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; }
}
function writeHidden(v: boolean) {
  try { v ? localStorage.setItem(HIDE_KEY, '1') : localStorage.removeItem(HIDE_KEY); } catch { /* fine: just not remembered */ }
}

const ICON: Record<string, ReactNode> = {
  interface: <path d="M8 7 3 12l5 5M16 7l5 5-5 5M13.5 5l-3 14" />,
  upgrades: <><path d="M12 17V5M7 10l5-5 5 5" /><path d="M5 20h14" /></>,
  identity: <><path d="M12 3 5 6v5c0 4.4 3 8.3 7 10 4-1.7 7-5.6 7-10V6z" /><path d="m9 12 2 2 4-4" /></>,
};

export default function BigDipperBanner() {
  const nav = useNavigate();
  const [hidden, setHidden] = useState(readHidden);
  const { data: bd } = useAsync(() => get<BigDipper>('/api/v1/big-dipper'), []);

  if (!bd || bd.contact?.status === 'active') return null;
  if (hidden) {
    return <button className="bare text-muted" style={{ fontSize: 12, marginTop: 14, textDecoration: 'underline' }} onClick={() => { writeHidden(false); setHidden(false); }}>About Big Dipper</button>;
  }
  const go = () => nav('/admin/settings/big-dipper');
  const started = bd.chosen.length > 0 || !!bd.contact;

  return (
    <section aria-label="Big Dipper" className="card" style={{ marginTop: 22, padding: '24px 26px', gap: 18, background: 'var(--color-neutral-900)', color: 'var(--color-neutral-100)', position: 'relative', overflow: 'hidden' }}>
      <div aria-hidden style={{ position: 'absolute', right: -80, bottom: -120, width: 280, height: 280, borderRadius: '50%', background: 'var(--color-accent-800)', opacity: 0.6 }} />
      <Dipper style={{ right: 24, top: 18, opacity: 0.9 }} />
      <div style={{ position: 'relative', maxWidth: 600 }}>
        <div className="card-kicker" style={{ color: 'var(--color-accent-300)' }}>Big Dipper · optional</div>
        <div className="card-title" style={{ fontSize: 22, marginTop: 4 }}>Add Big Dipper as a contact</div>
        <div style={{ fontSize: 14, color: 'var(--color-neutral-400)', marginTop: 6, textWrap: 'pretty' }}>
          A helping hand for running your own server. Big Dipper can check your Little Dipper, help keep it up to date and vouch for who you are, on your terms. It never gets the keys.
        </div>
      </div>

      <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 10 }}>
        {bd.services.map((s) => (
          <div key={s.key} style={{ display: 'flex', gap: 12, padding: '14px 16px', borderRadius: 18, background: 'color-mix(in srgb, var(--color-neutral-100) 7%, transparent)' }}>
            <svg aria-hidden width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-300)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', marginTop: 1 }}>{ICON[s.key]}</svg>
            <div><div style={{ fontWeight: 600, fontSize: 14 }}>{s.title}{bd.chosen.includes(s.key) && <span style={{ color: 'var(--color-accent-2-300)', fontWeight: 400 }}> · chosen</span>}</div><div style={{ fontSize: 13, color: 'var(--color-neutral-400)', marginTop: 3, lineHeight: 1.45 }}>{s.tagline}</div></div>
          </div>
        ))}
      </div>

      <div style={{ position: 'relative', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" style={{ background: 'var(--color-accent-2-600)' }} onClick={go}>{bd.contact ? 'Request sent · view' : started ? 'Review your choices' : 'See how it works'}</button>
        <span style={{ fontSize: 12, color: 'var(--color-neutral-400)' }}>Benefits, things to know and your options. Nothing is sent until you connect.</span>
        <button className="btn btn-ghost" style={{ color: 'var(--color-neutral-400)', marginLeft: 'auto' }} onClick={() => { writeHidden(true); setHidden(true); }}>Not now</button>
      </div>
    </section>
  );
}
