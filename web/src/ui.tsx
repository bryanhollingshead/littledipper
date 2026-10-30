import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import QRCode from 'qrcode';

// ── toast: bottom-center dark pill, auto-dismiss 2.4s ───────────────────
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<number | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    clearTimeout(t.current);
    t.current = window.setTimeout(() => setMsg(null), 2400);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div role="status" style={{ position: 'fixed', left: '50%', bottom: 28, transform: 'translateX(-50%)', background: 'var(--color-neutral-900)', color: 'var(--color-neutral-100)', padding: '12px 22px', borderRadius: 999, fontSize: 14, boxShadow: 'var(--shadow-lg)', zIndex: 60, maxWidth: '90vw' }}>{msg}</div>
      )}
    </ToastCtx.Provider>
  );
}

/** Wrap an async action: shows the server's message as a toast if it fails. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string | ((r: T) => string | void)): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      const m = typeof ok === 'function' ? ok(r) : ok;
      if (m) toast(m);
      return r;
    } catch (e) {
      toast((e as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { run, busy };
}

// ── toggle: 40×24 track, 18px knob, 150ms ───────────────────────────────
export function Toggle({ on, onChange, label, style }: { on: boolean; onChange: () => void; label: string; style?: CSSProperties }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onChange}
      style={{ width: 40, height: 24, borderRadius: 999, border: 'none', padding: 3, background: on ? 'var(--color-accent-2-600)' : 'var(--color-neutral-300)', cursor: 'pointer', display: 'flex', flex: 'none', transition: 'background .15s', ...style }}>
      <span style={{ width: 18, height: 18, borderRadius: '50%', background: 'var(--color-neutral-100)', boxShadow: 'var(--shadow-sm)', transform: `translateX(${on ? 16 : 0}px)`, transition: 'transform .15s' }} />
    </button>
  );
}

// ── pill tabs / segmented control ───────────────────────────────────────
export function Pills<K extends string>({ value, options, onChange, size = 13, dashed, style }: { value: K; options: [K, string][]; onChange: (k: K) => void; size?: number; dashed?: boolean; style?: CSSProperties }) {
  return (
    <div role="tablist" style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 999, border: `1px ${dashed ? 'dashed var(--color-neutral-500)' : 'solid var(--color-divider)'}`, width: 'max-content', maxWidth: '100%', overflowX: 'auto', ...style }}>
      {options.map(([k, label]) => {
        const on = k === value;
        return (
          <button key={k} type="button" role="tab" aria-selected={on} onClick={() => onChange(k)}
            style={{ border: 'none', cursor: 'pointer', font: 'inherit', fontSize: size, padding: size <= 12 ? '5px 12px' : '6px 14px', borderRadius: 999, whiteSpace: 'nowrap', flex: 'none', background: on ? 'var(--color-accent)' : 'transparent', color: on ? 'var(--color-bg)' : 'inherit' }}>
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── dialog: backdrop click closes; inner click doesn't ──────────────────
export function Dialog({ title, onClose, children, actions, width }: { title: ReactNode; onClose: () => void; children?: ReactNode; actions?: ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" style={{ zIndex: 50 }} onClick={onClose}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ width: width ? `min(${width}px, 100%)` : undefined, maxHeight: '90vh', overflow: 'auto' }}>
        <div className="dialog-title">{title}</div>
        {children}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

export type ConfirmCfg = { title: string; body: ReactNode; cta: string; onConfirm: () => void | Promise<void> };
export function Confirm({ cfg, onClose }: { cfg: ConfirmCfg; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={cfg.title} onClose={onClose} actions={<>
      <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={async () => { setBusy(true); try { await cfg.onConfirm(); } finally { setBusy(false); } }}>{cfg.cta}</button>
    </>}>
      <div className="dialog-body">{cfg.body}</div>
    </Dialog>
  );
}

// ── small pieces ────────────────────────────────────────────────────────
export const Dot = ({ color, size = 10, pulse }: { color: string; size?: number; pulse?: boolean }) => (
  <span style={{ width: size, height: size, borderRadius: '50%', background: color, flex: 'none', display: 'inline-block', animation: pulse ? 'ldpulse 1.6s infinite' : undefined }} />
);

export const Avatar = ({ text, bg, size = 34, font }: { text: string; bg: string; size?: number; font?: string }) => (
  <span style={{ width: size, height: size, borderRadius: '50%', background: bg, display: 'grid', placeItems: 'center', fontSize: size >= 60 ? 22 : size >= 38 ? 13 : 12, fontFamily: font, flex: 'none' }}>{text}</span>
);

export const Brand = ({ name, size = 28, font = 20 }: { name: string; size?: number; font?: number }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
    <span style={{ width: size, height: size, borderRadius: '50%', background: 'var(--color-accent)', flex: 'none' }} />
    <span style={{ fontFamily: 'var(--font-heading)', fontSize: font }}>{name}</span>
  </div>
);

/** label ⟷ value row with a divider. */
export const KV = ({ k, v, mono, pad = '10px 0', size = 14 }: { k: ReactNode; v: ReactNode; mono?: boolean; pad?: string; size?: number }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: pad, borderBottom: '1px solid var(--color-divider)', flexWrap: 'wrap' }}>
    <span className="text-muted" style={{ fontSize: 13 }}>{k}</span>
    <span style={{ fontSize: mono ? 13 : size, fontFamily: mono ? 'var(--mono)' : undefined, overflowWrap: 'anywhere' }}>{v}</span>
  </div>
);

export const Striped = ({ size, radius = '50%', label, step = 8 }: { size: number; radius?: string | number; label?: string; step?: number }) => (
  <div style={{ width: size, height: size, borderRadius: radius, background: `repeating-linear-gradient(45deg,var(--color-neutral-200) 0 ${step}px,var(--color-neutral-300) ${step}px ${step * 2}px)`, display: 'grid', placeItems: 'center', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--color-neutral-700)', flex: 'none' }}>{label}</div>
);

export function QR({ text, size = 150 }: { text: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(text, { margin: 1, width: size * 2, color: { dark: '#1c2230', light: '#fbf9f6' } }).then(setSrc).catch(() => setSrc(null));
  }, [text, size]);
  return src ? <img src={src} alt="QR code for the invite link" width={size} height={size} style={{ borderRadius: 24, flex: 'none' }} /> : <Striped size={size} radius={24} label="QR code" />;
}

/** Decorative soft circles. */
export const Circle = ({ style }: { style: CSSProperties }) => <div aria-hidden style={{ position: 'absolute', borderRadius: '50%', pointerEvents: 'none', ...style }} />;

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    fn().then((d) => live && (setData(d), setError(null))).catch((e) => live && setError(e));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, reload: () => setN((x) => x + 1), setData };
}

export const Loading = () => <p className="text-muted" style={{ fontSize: 14 }}>Loading…</p>;
export const ErrorNote = ({ error }: { error: Error }) => <p style={{ color: 'var(--color-accent-700)', fontSize: 14 }}>{error.message}</p>;
