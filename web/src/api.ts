/** The admin UI talks to nothing but this REST API. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, data?.code || 'error', data?.message || `Request failed (${res.status})`);
  return data as T;
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T = any>(p: string, b: unknown) => api<T>('PUT', p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);

// ── shared shapes ──────────────────────────────────────────────────────
export type Sensitivity = 'standard' | 'sensitive' | 'secret';
export type Field = { key: string; label: string; section: string; sensitivity: Sensitivity; value: string; masked: boolean; hasValue: boolean; derivedFrom?: string | null; public?: boolean; sharedWith?: number; updatedAt: string };
export type Method = { type: string; label: string; value: string };
export type ContactStatus = 'plain' | 'pending_in' | 'pending_out' | 'active';
export type Contact = {
  id: string; kind: 'person' | 'node'; displayName: string; org: string | null; status: ContactStatus;
  node: { url: string; nodeId: string; linkId: string } | null; grants: { profile: boolean; fields: string[]; domains?: Record<string, { scope: 'all' | 'current'; includeSecret: boolean }> };
  lastActivity: { text: string; at: string }; createdAt: string; methods: Method[];
};
export type ContactDetail = Contact & {
  notes: string; requested: string[]; offered: string[]; sharedIn: { key: string; label: string; value: string }[]; sharedInFetchedAt: string | null;
  request: { id: string; direction: 'in' | 'out'; note: string; quiet: boolean; viaInvite: boolean; expiresAt: string; requestedFields: string[] } | null;
  timeline: { label: string; at: string }[];
  sharedDomains?: { domain: string; label: string; scope: 'all' | 'current'; records: { id: string; title: string; fields: { key: string; label: string; value: string }[]; validFrom: string | null; validTo: string | null; current: boolean }[] }[];
  keys: { peerSigningKey: string; peerVersion: string | null; tokenIssued: { prefix: string; scopes: string[]; lastUsedAt: string | null } | null; tokenFromPeer: { stored: boolean; lastUsedAt: string | null } | null; lastSyncAt: string | null; rotatedAt: string | null } | null;
  syncError?: string | null;
};
export type NodeInfo = {
  id: string; signingKey: string; address: string;
  addresses: { host: string; domain: string | null; domainStatus: 'none' | 'pending' | 'active'; records: { type: string; name: string; value: string }[] };
  version: string; update: { current: string; latest: string; available: boolean; notes: string; canSelfUpdate: boolean };
  hosting: { provider: string; label: string; region: string; store: string; documents: number };
  lastBackupAt: string | null; publicViewsToday: number; claimedAt: string | null;
  /** Whether a backup has reached the owner's own device lately; `due` drives the reminder. */
  deviceBackup: { lastAt: string | null; via: 'download' | 'folder' | null; remindAfterDays: number; due: boolean };
};
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'received' | 'read';
export type Message = {
  id: string; contactId: string; conversationId: string; direction: 'in' | 'out'; kind: string; body: unknown; inReplyTo: string | null;
  transport: 'peer' | 'email' | 'service'; status: MessageStatus; lastError: string | null; createdAt: string; sentAt: string | null; deliveredAt: string | null; readAt: string | null;
};
export type Conversation = {
  contact: Pick<Contact, 'id' | 'displayName' | 'kind' | 'status' | 'node'>;
  last: { id: string; direction: 'in' | 'out'; kind: string; preview: string; status: MessageStatus; at: string };
  unread: number; canMessage: boolean;
};
export type Owner = { id: string; displayName: string; email: string; prefs: { showTechnical: boolean }; role: string };
export type AuditEvent = { _id: string; at: string; action: string; text: string; tone: 'peer' | 'request' | 'owner' | 'system' };

// ── formatting ─────────────────────────────────────────────────────────
export const addr = (url: string) => url.replace(/^https?:\/\//, '');
export const initials = (n: string) => n.replace(/^(Dr|Mr|Mrs|Ms|Mx)\.?\s+/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
export const firstName = (n: string) => n.replace(/^(Dr|Mr|Mrs|Ms|Mx)\.?\s+/i, '').split(' ')[0];

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 2) return 'yesterday';
  return shortDate(iso);
}
export const shortDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
export const longDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export function whenLabel(iso: string) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return `Today ${clock(iso)}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${clock(iso)}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${clock(iso)}`;
}

export const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);

/** Where a derived profile field gets its value. */
export const DERIVED_LABEL: Record<string, string> = { residences: 'Residences', contact_methods: 'Contact methods' };

export const SENS: Record<Sensitivity, [string, string]> = { standard: ['Standard', 'tag-neutral'], sensitive: ['Sensitive', 'tag-accent-2'], secret: ['Secret', 'tag-accent'] };
export const STATUS: Record<ContactStatus, [string, string]> = { active: ['Connected', 'tag-accent-2'], pending_in: ['Wants to connect', 'tag-accent'], pending_out: ['Awaiting approval', 'tag-neutral'], plain: ['Contact only', 'tag-neutral'] };

/** Browser-side download of data we already have (the API call already happened). */
export function saveFile(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── files ──────────────────────────────────────────────────────────────
export type FileRef = { id: string; name: string; type: string; size: number };
export const fileUrl = (id: string) => `/api/v1/files/${id}`;
export const FILE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,application/pdf';

/** Phone photos are 3–8 MB; a receipt reads fine at 2000px. Anything the browser can't draw goes up as-is. */
export async function shrink(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1_500_000) return file;
  try {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return out && out.size < file.size ? out : file;
  } catch { return file; }
}

async function sendBytes<T>(url: string, file: File): Promise<T> {
  const body = await shrink(file);
  const type = body.type || file.type;
  const name = type === 'image/jpeg' && file.type !== 'image/jpeg' ? file.name.replace(/\.\w+$/, '') + '.jpg' : file.name;
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}name=${encodeURIComponent(name)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': type }, body });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.code || 'error', data?.message || `Upload failed (${res.status})`);
  return data as T;
}

/** One file becomes a new document. With link it's filed on that entry; without, it lands in the inbox. */
export function uploadDocument(file: File, opts: { link?: { domain: string; recordId: string }; kind?: string } = {}) {
  const q = new URLSearchParams();
  if (opts.link) q.set('link', `${opts.link.domain}:${opts.link.recordId}`);
  if (opts.kind) q.set('kind', opts.kind);
  return sendBytes<DocFull>(`/api/v1/documents?${q}`, file);
}
export const addPage = (docId: string, file: File) => sendBytes<DocFull>(`/api/v1/documents/${docId}/pages`, file);

export type DocLink = { domain: string; recordId: string };
export type DocRef = { id: string; title: string; kind: string; date: string | null; status: 'inbox' | 'filed'; pages: FileRef[]; links: DocLink[] };
export type Suggestion = { id: string; domain: string; recordId: string | null; data: Record<string, unknown>; validFrom?: string | null; validTo?: string | null; note: string; by: { type: string; id: string }; at: string };
export type DocFull = Omit<DocRef, 'links'> & {
  links: (DocLink & { domainLabel: string; title: string | null })[];
  text: string; notes: string; from: { type: string; id: string }; suggestions: Suggestion[]; createdAt: string; updatedAt: string;
};
export type Share = { id: string; expiresAt: string; revokedAt: string | null; views: number; lastViewedAt: string | null; createdAt: string; active: boolean };

export async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
