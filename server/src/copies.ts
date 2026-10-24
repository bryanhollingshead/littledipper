/**
 * Copies: a snapshot of chosen entries for someone without a Little Dipper (a landlord, a recruiter, a new doctor).
 * They get what's here today, as a link that can expire, or as a PDF, JSON or text file the owner sends.
 * Later changes don't reach them. A link can be turned off; a file they've saved can't be taken back.
 */
import { ctx } from './ctx.js';
import { decrypt, encrypt, newId } from './crypto.js';
import { bad, HttpError } from './auth.js';
import { shapeRecords, type SharedDomain } from './domains/sharing.js';
import { getDomain, partSens, recordsOf, sortRecords } from './domains/records.js';
import { now, type ContactDoc } from './federation.js';
import { firstName } from './contacts.js';

export type Delivery = 'link' | 'file' | 'inline';
export const DELIVERIES: Delivery[] = ['link', 'file', 'inline'];
/** 0 = until the owner turns it off. */
export const LINK_HOURS = [1, 24, 24 * 7, 24 * 30, 0];
export const FORMATS = { pdf: 'application/pdf', json: 'application/json', txt: 'text/plain; charset=utf-8' } as const;
export type Format = keyof typeof FORMATS;

export type CopyItem = { domain: string; recordIds: string[]; includeSecret: boolean };
export type CopyDoc = {
  _id: string;
  title: string;
  items: CopyItem[];
  /** SharedDomain[] as JSON, encrypted with the master key: it may hold secret values. */
  snapshotEnc: string;
  note: string;
  delivery: Delivery;
  contactId: string | null;
  sentTo: string | null;
  /** Link only. */
  tokenHash: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  views: number;
  downloads: number;
  lastViewedAt: string | null;
  createdAt: string;
};

export const snapshotOf = (c: CopyDoc): SharedDomain[] => JSON.parse(decrypt(ctx.keys.masterKey, c.snapshotEnc));
export const linkActive = (c: CopyDoc) => !!c.tokenHash && !c.revokedAt && (!c.expiresAt || c.expiresAt > new Date().toISOString());

export async function copyOut(c: CopyDoc) {
  const contact = c.contactId ? await ctx.store.get<ContactDoc>('contacts', c.contactId) : null;
  return {
    id: c._id, title: c.title, note: c.note, delivery: c.delivery,
    items: c.items.map((i) => ({ domain: i.domain, entries: i.recordIds.length, includeSecret: i.includeSecret })),
    contact: contact ? { id: contact._id, displayName: contact.displayName } : null, sentTo: c.sentTo,
    link: c.tokenHash ? { active: linkActive(c), expiresAt: c.expiresAt, revokedAt: c.revokedAt } : null,
    views: c.views, downloads: c.downloads, lastViewedAt: c.lastViewedAt, createdAt: c.createdAt,
  };
}

/** Check what the owner picked and take the snapshot. Secret details (and secret categories) need confirm. */
export async function takeSnapshot(input: unknown, confirm: boolean) {
  if (!Array.isArray(input) || !input.length) throw bad('invalid_value', 'Choose at least one category: items: [{ domain, recordIds?, includeSecret? }]');
  if (input.length > 20) throw bad('invalid_value', 'Up to 20 categories in one copy');
  const items: CopyItem[] = [];
  const snapshot: SharedDomain[] = [];
  for (const raw of input as { domain?: string; recordIds?: unknown; includeSecret?: unknown }[]) {
    const d = await getDomain(String(raw?.domain || ''));
    if (!d) throw bad('invalid_value', `No category ${raw?.domain}`);
    if (items.some((i) => i.domain === d.id)) throw bad('invalid_value', `${d.label} is listed twice`);
    const all = sortRecords(d, await recordsOf(d.id));
    let recs = all;
    if (raw.recordIds !== undefined) {
      if (!Array.isArray(raw.recordIds)) throw bad('invalid_value', 'recordIds must be a list');
      const want = new Set(raw.recordIds.map(String));
      recs = all.filter((r) => want.has(r._id));
      if (recs.length !== want.size) throw bad('invalid_value', `Some of those entries aren't in ${d.label}`);
    }
    if (!recs.length) throw bad('invalid_value', `Nothing chosen from ${d.label}`);
    const includeSecret = raw.includeSecret === true;
    const hasSecret = d.parts.some((p) => partSens(d, p) === 'secret');
    if (hasSecret && (includeSecret || d.sensitivity === 'secret') && !confirm) throw new HttpError(409, 'confirm_required', `Sending ${d.label} needs confirmation`);
    items.push({ domain: d.id, recordIds: recs.map((r) => r._id), includeSecret });
    snapshot.push({ domain: d.id, label: d.label, scope: 'all', records: await shapeRecords(d, recs, includeSecret) });
  }
  return { items, snapshot, snapshotEnc: encrypt(ctx.keys.masterKey, JSON.stringify(snapshot)) };
}

export function titleFor(snapshot: SharedDomain[]) {
  const l = snapshot.map((s) => s.label);
  return l.length <= 2 ? l.join(' and ') : `${l.slice(0, 2).join(', ')} and ${l.length - 2} more`;
}

// ── who it's for: an existing contact, or one added from the email address ─

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function recipient(to: { contactId?: string; email?: string; name?: string } | undefined) {
  if (!to || (!to.contactId && !to.email)) return { contact: null, email: null, created: false };
  const email = to.email?.trim() || null;
  if (email && !EMAIL.test(email)) throw bad('invalid_value', 'That email address doesn’t look right');
  if (to.contactId) {
    const c = await ctx.store.get<ContactDoc>('contacts', to.contactId);
    if (!c) throw bad('invalid_value', 'No such contact');
    return { contact: c, email: email ?? c.methods.find((m) => m.type === 'email')?.value ?? null, created: false };
  }
  const lower = email!.toLowerCase();
  const all = await ctx.store.find<ContactDoc>('contacts', {});
  const found = all.find((c) => c.methods.some((m) => m.type === 'email' && m.value.trim().toLowerCase() === lower));
  if (found) return { contact: found, email, created: false };
  const t = now();
  const c: ContactDoc = {
    _id: newId('con'), kind: 'person', displayName: to.name?.trim().slice(0, 120) || email!, org: null,
    methods: [{ type: 'email', label: 'Email', value: email! }], notes: '', node: null,
    sharedIn: [], sharedInFetchedAt: null, requested: [], offered: [], lastActivity: { text: 'Added when you sent a copy', at: t }, createdAt: t,
  };
  await ctx.store.insert('contacts', c);
  return { contact: c, email, created: true };
}

/** The message the owner sends from their own mail app (the node doesn't send email). */
export function emailFor(o: { to: string | null; name: string | null; owner: string; title: string; delivery: Delivery; url: string | null; expiresAt: string | null; note: string; text: string }) {
  const hi = o.name && !o.name.includes('@') ? `Hi ${firstName(o.name)},\n\n` : 'Hi,\n\n';
  const what = `my ${o.title.toLowerCase()}`;
  const note = o.note ? `${o.note}\n\n` : '';
  const body = o.delivery === 'link'
    ? `${hi}${note}Here's a copy of ${what}:\n\n${o.url}\n\n${o.expiresAt ? `The link works until ${longDate(o.expiresAt)}. ` : ''}You can save it from that page as a PDF, JSON or text file.\n\n${o.owner}`
    : o.delivery === 'file'
      ? `${hi}${note}A copy of ${what} is attached.\n\n${o.owner}`
      : `${hi}${note}Here's a copy of ${what}:\n\n${o.text}\n\n${o.owner}`;
  return { to: o.to ?? '', subject: `${o.title}${o.owner ? ` from ${o.owner}` : ''}`, body };
}

// ── formats ──────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const longDate = (iso: string) => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const partial = (v: string) => (v.length === 4 ? v : v.length === 7 ? `${MONTHS[+v.slice(5, 7) - 1]} ${v.slice(0, 4)}` : `${+v.slice(8, 10)} ${MONTHS[+v.slice(5, 7) - 1]} ${v.slice(0, 4)}`);
export const range = (from: string | null, to: string | null) => (from || to ? `${from ? partial(from) : '?'} – ${to ? partial(to) : 'now'}` : '');

type Meta = { title: string; sharedBy: string; createdAt: string; note: string };

export function asJson(m: Meta, snapshot: SharedDomain[]) {
  return JSON.stringify({
    format: 'little-dipper.copy/v1', title: m.title, sharedBy: m.sharedBy, copiedAt: m.createdAt, note: m.note || undefined,
    categories: snapshot.map((s) => ({
      category: s.domain, label: s.label,
      entries: s.records.map((r) => ({ title: r.title, validFrom: r.validFrom ?? undefined, validTo: r.validTo ?? undefined, current: r.current, details: r.data })),
    })),
  }, null, 2);
}

/** Lines shared by the text and PDF formats. */
function lines(m: Meta, snapshot: SharedDomain[]) {
  const out: { text: string; style: 'h1' | 'meta' | 'note' | 'h2' | 'h3' | 'body' | 'row' | 'muted' | 'gap' }[] = [];
  out.push({ text: m.title, style: 'h1' });
  out.push({ text: `${m.sharedBy ? `From ${m.sharedBy} · ` : ''}copied ${longDate(m.createdAt)}`, style: 'meta' });
  if (m.note) out.push({ text: m.note, style: 'note' });
  for (const s of snapshot) {
    out.push({ text: '', style: 'gap' });
    if (snapshot.length > 1) out.push({ text: s.label, style: 'h2' });
    for (const r of s.records) {
      out.push({ text: r.title, style: 'h3' });
      const when = range(r.validFrom, r.validTo);
      if (when) out.push({ text: when, style: 'muted' });
      for (const f of r.fields) {
        out.push({ text: f.rows ? `${f.label}:` : `${f.label}: ${f.value}`, style: 'body' });
        for (const row of f.rows ?? []) out.push({ text: `• ${row}`, style: 'row' });
      }
      out.push({ text: '', style: 'gap' });
    }
  }
  return out;
}

export function asText(m: Meta, snapshot: SharedDomain[]) {
  const t: string[] = [];
  for (const l of lines(m, snapshot)) {
    if (l.style === 'gap') { if (t[t.length - 1] !== '') t.push(''); continue; }
    if (l.style === 'h1') t.push(l.text, '='.repeat(Math.min(60, l.text.length)));
    else if (l.style === 'h2') t.push(l.text.toUpperCase(), '');
    else t.push(l.style === 'body' ? `  ${l.text}` : l.style === 'row' ? `    ${l.text}` : l.text);
  }
  return t.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// ── a small PDF writer: Helvetica, word-wrapped, US Letter ────────────────

// Helvetica advance widths (1/1000 em) for ASCII 32–126.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const WIN: Record<string, number> = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };

/** Unicode → WinAnsi bytes; anything else loses its accent or becomes '?'. */
function winAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 32 && c <= 126) || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (WIN[ch]) out.push(WIN[ch]);
    else {
      const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      out.push(...(base && base !== ch ? winAnsi(base) : [63]));
    }
  }
  return out;
}
const width = (b: number[], size: number, bold: boolean) => (b.reduce((w, c) => w + (c >= 32 && c <= 126 ? HELV[c - 32] : 556), 0) * size * (bold ? 1.08 : 1)) / 1000;

function wrap(b: number[], max: number, size: number, bold: boolean): number[][] {
  const out: number[][] = [];
  let line: number[] = [];
  for (const word of splitWords(b)) {
    const next = line.length ? [...line, ...word] : word.filter((c, i) => i > 0 || c !== 32);
    if (width(next, size, bold) <= max || !line.length) { line = next; continue; }
    out.push(line);
    line = word.filter((c, i) => i > 0 || c !== 32);
  }
  out.push(line);
  // A word wider than the line (a long URL) is cut by width.
  return out.flatMap((l) => {
    if (width(l, size, bold) <= max) return [l];
    const parts: number[][] = [];
    let cur: number[] = [];
    for (const c of l) { if (cur.length && width([...cur, c], size, bold) > max) { parts.push(cur); cur = []; } cur.push(c); }
    return [...parts, cur];
  });
}
function splitWords(b: number[]) {
  const words: number[][] = [];
  let cur: number[] = [];
  for (const c of b) { if (c === 32 && cur.length) { words.push(cur); cur = []; } cur.push(c); }
  if (cur.length) words.push(cur);
  return words;
}

const hex = (b: number[]) => `<${b.map((c) => c.toString(16).padStart(2, '0')).join('')}>`;

export function asPdf(m: Meta, snapshot: SharedDomain[]): Buffer {
  const W = 612, H = 792, M = 60, MAXW = W - 2 * M;
  const STYLE = { h1: [22, true, 0.1, 10], meta: [10, false, 0.45, 4], h2: [14, true, 0.1, 10], h3: [12, true, 0.1, 5], body: [10.5, false, 0.15, 4], row: [10.5, false, 0.15, 2], note: [11, false, 0.15, 8], muted: [10, false, 0.45, 3] } as const;
  const pages: string[][] = [[]];
  let y = H - M;
  for (const l of lines(m, snapshot)) {
    if (l.style === 'gap') { y -= 8; continue; }
    const [size, bold, gray, before] = STYLE[l.style];
    const indent = l.style === 'body' ? 12 : l.style === 'row' ? 24 : 0;
    y -= before;
    for (const row of wrap(winAnsi(l.text), MAXW - indent, size, bold)) {
      if (y - size < M + 20) { pages.push([]); y = H - M; }
      y -= size * 1.25;
      pages[pages.length - 1].push(`${gray} g BT /${bold ? 'F2' : 'F1'} ${size} Tf ${M + indent} ${y.toFixed(2)} Td ${hex(row)} Tj ET`);
    }
  }
  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  pages.forEach((ops, i) => {
    const foot = `0.55 g BT /F1 8 Tf ${M} ${M - 10} Td ${hex(winAnsi(`Copied from ${m.sharedBy ? `${m.sharedBy}’s ` : ''}Little Dipper · ${longDate(m.createdAt)} · page ${i + 1} of ${pages.length}`))} Tj ET`;
    const stream = [...ops, foot].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${hex(winAnsi(m.title))} /Producer (Little Dipper) >>`);
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

export function render(format: Format, m: Meta, snapshot: SharedDomain[]): Buffer {
  return format === 'pdf' ? asPdf(m, snapshot) : Buffer.from(format === 'json' ? asJson(m, snapshot) : asText(m, snapshot), 'utf8');
}

export const fileName = (title: string, createdAt: string, format: Format) =>
  `${title.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'copy'}-${createdAt.slice(0, 10)}.${format}`;
