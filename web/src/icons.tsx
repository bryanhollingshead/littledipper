/** Hand-drawn two-tone icons: a soft fill (--icon-fill) under a currentColor outline. */
import type { ReactNode } from 'react';

const F = { fill: 'var(--icon-fill)' };
const N = { fill: 'none' };
const D = { fill: 'currentColor', stroke: 'none' };

const PATHS: Record<string, ReactNode> = {
  home: <>
    <path {...F} d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
    <path {...N} d="M10 20v-4.5a2 2 0 0 1 4 0V20" />
    <path {...D} d="m17.5 2.2.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z" />
  </>,
  data: <>
    <rect {...N} x="6" y="3" width="13" height="9" rx="2" opacity=".55" />
    <rect {...F} x="3" y="8" width="18" height="12" rx="2.5" />
    <circle {...D} cx="8" cy="14" r="1.8" />
    <path {...N} d="M12 12.6h5M12 15.6h3.5" />
  </>,
  documents: <>
    <path {...F} d="M6.5 3H14l5 5v11.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3z" />
    <path {...N} d="M14 3v4a1 1 0 0 0 1 1h4M8.5 13h7M8.5 16.5h5" />
  </>,
  lifestream: <>
    <path {...N} d="M4.5 19c4 0 3.5-5 7.5-5s3.5-5 7.5-5" />
    <circle {...F} cx="4.5" cy="19" r="2.2" />
    <circle {...F} cx="12" cy="14" r="2.2" />
    <circle {...F} cx="19.5" cy="9" r="2.2" />
    <path {...D} d="m19.5 1.8.55 1.45 1.45.55-1.45.55-.55 1.45-.55-1.45-1.45-.55 1.45-.55z" />
  </>,
  calendar: <>
    <rect {...F} x="3.5" y="5" width="17" height="15.5" rx="3" />
    <path {...N} d="M3.5 10h17M8 3v4M16 3v4" />
    <circle {...D} cx="8.5" cy="14.2" r="1.15" />
    <circle {...D} cx="12" cy="14.2" r="1.15" opacity=".45" />
    <circle {...D} cx="15.5" cy="17.2" r="1.15" opacity=".45" />
  </>,
  receipts: <>
    <path {...F} d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21z" />
    <path {...N} d="M9 7.5h6M9 11h6M9 14.5h3.5" />
  </>,
  contacts: <>
    <circle {...N} cx="16.5" cy="8" r="2.5" opacity=".6" />
    <path {...N} d="M15.5 13.6c.3-.1.6-.1 1-.1 2.8 0 4.5 2 4.5 5" opacity=".6" />
    <circle {...F} cx="9" cy="8.5" r="3" />
    <path {...F} d="M3 20c0-3.6 2.6-6 6-6s6 2.4 6 6z" />
  </>,
  messages: <>
    <path {...F} d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V17A2.5 2.5 0 0 1 4 14.5z" />
    <circle {...D} cx="8.5" cy="10.5" r="1.1" /><circle {...D} cx="12" cy="10.5" r="1.1" /><circle {...D} cx="15.5" cy="10.5" r="1.1" />
  </>,
  profile: <>
    <rect {...F} x="3" y="5" width="18" height="15" rx="2.5" />
    <path {...N} d="M10 5V3.5h4V5" />
    <circle {...N} cx="9" cy="11" r="2.2" />
    <path {...N} d="M5.6 16.5c.6-1.5 1.9-2.4 3.4-2.4s2.8.9 3.4 2.4M14.5 10.5h3.5M14.5 14h2.5" />
  </>,
  apps: <>
    <circle {...F} cx="8" cy="15" r="4.5" />
    <circle {...D} cx="8" cy="15" r="1.2" />
    <path {...N} d="m11.3 11.7 8-8M16.3 6.7l2 2M13.8 9.2l1.5 1.5" />
  </>,
  settings: <>
    <path {...N} d="M4 7h16M4 12h16M4 17h16" />
    <circle {...F} cx="9" cy="7" r="2.2" />
    <circle {...F} cx="15.5" cy="12" r="2.2" />
    <circle {...F} cx="7" cy="17" r="2.2" />
  </>,
  model: <>
    <path {...N} d="M3.5 17 8 15l4 1.5 3-4.5 5 1 .5-5-4.5-1-1 4.5" opacity=".7" />
    {([[3.5, 17, 1.5], [8, 15, 1.5], [12, 16.5, 1.5], [15, 12, 1.8], [20, 13, 1.8], [20.5, 8, 1.8], [16, 7, 1.8]] as const).map(([x, y, r]) => <circle key={`${x},${y}`} {...F} cx={x} cy={y} r={r} />)}
  </>,
  endpoints: <>
    <path {...N} d="M9 3v4M15 3v4M12 16v5" />
    <path {...F} d="M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0z" />
  </>,
  /** Points left; the folded sidebar mirrors it to point right. */
  collapse: <path {...N} d="M14.5 6 8.5 12l6 6" strokeWidth={2} />,
  signout: <>
    <path {...F} d="M5 4h8v16H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    <path {...N} d="M13 4h1.5a1 1 0 0 1 1 1v2M15.5 17v2a1 1 0 0 1-1 1H13M12 12h9M18.5 9.5 21 12l-2.5 2.5" />
  </>,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false"
      stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" style={{ flex: 'none', overflow: 'visible' }}>
      {PATHS[name]}
    </svg>
  );
}
