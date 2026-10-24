import { existsSync } from 'node:fs';
import path from 'node:path';

export const VERSION = '0.1.0';

function detectHosting(): { provider: 'render' | 'railway' | 'fly' | 'docker' | 'other'; region: string; label: string } {
  const e = process.env;
  if (e.RENDER || e.RENDER_SERVICE_ID) return { provider: 'render', region: e.RENDER_REGION || e.LD_REGION || '', label: 'Render' };
  if (e.RAILWAY_ENVIRONMENT || e.RAILWAY_PROJECT_ID) return { provider: 'railway', region: e.RAILWAY_REGION || e.LD_REGION || '', label: 'Railway' };
  if (e.FLY_APP_NAME) return { provider: 'fly', region: e.FLY_REGION || e.LD_REGION || '', label: 'Fly.io' };
  if (existsSync('/.dockerenv')) return { provider: 'docker', region: e.LD_REGION || '', label: 'Docker' };
  return { provider: 'other', region: e.LD_REGION || '', label: 'Self-hosted' };
}

function publicUrl(): string {
  const e = process.env;
  if (e.LD_PUBLIC_URL) return e.LD_PUBLIC_URL.replace(/\/+$/, '');
  // Cloud installs default to the provider hostname, never a raw IP.
  if (e.RENDER_EXTERNAL_URL) return e.RENDER_EXTERNAL_URL.replace(/\/+$/, '');
  if (e.RENDER_EXTERNAL_HOSTNAME) return `https://${e.RENDER_EXTERNAL_HOSTNAME}`;
  if (e.RAILWAY_PUBLIC_DOMAIN) return `https://${e.RAILWAY_PUBLIC_DOMAIN}`;
  if (e.FLY_APP_NAME) return `https://${e.FLY_APP_NAME}.fly.dev`;
  return `http://localhost:${e.PORT || 4000}`;
}

const port = Number(process.env.PORT || 4000);

export const config = {
  port,
  host: process.env.HOST || '0.0.0.0',
  /** The host address this instance was deployed with. Configuration, never hard-coded. */
  hostUrl: publicUrl(),
  dataDir: path.resolve(process.env.LD_DATA_DIR || './data'),
  mongoUri: process.env.MONGODB_URI || '',
  mongoDb: process.env.MONGODB_DB || 'little_dipper',
  /** Built web app to serve. */
  webDist: path.resolve(process.env.LD_WEB_DIST || new URL('../../web/dist', import.meta.url).pathname),
  /** Development: send page requests to the Vite dev server, so links to this address (claim, share, copy) open the current app. */
  webDevUrl: (process.env.LD_WEB_DEV_URL || '').replace(/\/+$/, ''),
  hosting: detectHosting(),
  /** Optional: a deploy hook (e.g. Render deploy hook URL) used by "Update now". */
  deployHookUrl: process.env.LD_DEPLOY_HOOK_URL || '',
  /** Optional: JSON endpoint returning { version, notes } for the latest release. */
  updateFeedUrl: process.env.LD_UPDATE_FEED_URL || '',
  /** Big Dipper's node address, once it exists. Empty: the Contacts banner says "coming soon". */
  bigDipperUrl: (process.env.LD_BIG_DIPPER_URL || '').replace(/\/+$/, ''),
  /** Allow plain http for peers on these hosts (local development). */
  devInsecurePeers: process.env.LD_ALLOW_HTTP_PEERS === '1' || /^http:\/\/(localhost|127\.)/.test(publicUrl()),
  sessionDays: 30,
};

export type Config = typeof config;
