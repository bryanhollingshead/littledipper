/**
 * Documents: scans, photos and PDFs the owner keeps. A document has one or more pages (files),
 * can stand alone in the library, and can be linked to entries in My data (a license scan to the
 * driver's license entry, a lease to a residence). Assistants read documents and send back
 * suggestions; the owner accepts them into structured records.
 */
import { ctx } from './ctx.js';
import { bad, HttpError, notFound, type Principal } from './auth.js';
import { decrypt, encrypt, newId } from './crypto.js';
import { deleteFile, fileRef, type FileDoc, type FileRef, type Source } from './files.js';
import { getDomain, isPartialDate, listDomains, recordOut, type RecordDoc } from './domains/records.js';

/** Open set: clients show unknown kinds as "Document". */
export const DOC_KINDS: [string, string][] = [
  ['id', 'ID document'], ['card', 'Card'], ['insurance_card', 'Insurance card'], ['receipt', 'Receipt'], ['invoice', 'Invoice'],
  ['statement', 'Statement'], ['tax_form', 'Tax form'], ['medical', 'Medical record'], ['lease', 'Lease'], ['contract', 'Contract'],
  ['deed', 'Deed'], ['title', 'Title'], ['registration', 'Registration'], ['certificate', 'Certificate'], ['letter', 'Letter'],
  ['warranty', 'Warranty'], ['manual', 'Manual'], ['resume', 'Résumé / CV'], ['photo', 'Photo'], ['other', 'Other'],
];
const KIND_RE = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_PAGES = 30;
const MAX_TEXT = 200_000;
const MAX_LINKS = 20;
const MAX_SUGGESTIONS = 10;

export type DocLink = { domain: string; recordId: string };
export type Suggestion = {
  id: string;
  /** Create a record in this domain, or update recordId when set. */
  domain: string;
  recordId: string | null;
  data: Record<string, unknown>;
  validFrom?: string | null;
  validTo?: string | null;
  note: string;
  by: Source;
  at: string;
};
export type DocumentDoc = {
  _id: string;
  title: string;
  kind: string;
  /** inbox: just arrived, not sorted. filed: in the library. */
  status: 'inbox' | 'filed';
  /** When the document is from (issue date, statement date). Partial ISO date. */
  date: string | null;
  pages: FileRef[];
  links: DocLink[];
  /** Text read from the pages (by an assistant). Encrypted: it can hold ID numbers. */
  text: string;
  notes: string;
  from: Source;
  suggestions: Suggestion[];
  createdAt: string;
  updatedAt: string;
};

// ── access ─────────────────────────────────────────────────────────────

/** Whole library, or only documents linked to a domain the key can read/write. */
export function docScopes(doc: Pick<DocumentDoc, 'links'> | null, write: boolean) {
  const verb = write ? 'write' : 'read';
  return [`documents:${verb}`, `records:${verb}`, ...(doc?.links ?? []).map((l) => `${l.domain}:${verb}`)];
}
export function canSee(p: Principal, doc: DocumentDoc) {
  const s = p.key.scopes;
  return s.includes('admin:*') || docScopes(doc, false).some((x) => s.includes(x));
}

export async function documentOr404(id: string) {
  const d = await ctx.store.get<DocumentDoc>('documents', id);
  if (!d) throw notFound('document_not_found');
  return d;
}

// ── shapes ─────────────────────────────────────────────────────────────

/** The summary that appears on a record and in lists. */
export const docRef = (d: DocumentDoc) => ({ id: d._id, title: d.title, kind: d.kind, date: d.date, status: d.status, pages: d.pages, links: d.links });
export type DocRef = ReturnType<typeof docRef>;

export async function documentOut(d: DocumentDoc) {
  const links = [];
  for (const l of d.links) {
    const dom = await getDomain(l.domain);
    const rec = dom ? await ctx.store.get<RecordDoc & { [k: string]: unknown }>('records', l.recordId) : null;
    links.push({ ...l, domainLabel: dom?.label ?? l.domain, title: dom && rec ? recordOut(dom, rec as RecordDoc).title : null });
  }
  return {
    id: d._id, title: d.title, kind: d.kind, status: d.status, date: d.date, pages: d.pages, links,
    text: d.text ? decrypt(ctx.keys.masterKey, d.text) : '', notes: d.notes, from: d.from,
    suggestions: d.suggestions, createdAt: d.createdAt, updatedAt: d.updatedAt,
  };
}

/** Documents linked to each record of a domain: what record lists show beside each entry. */
export async function documentsByRecord(domain: string): Promise<Map<string, DocRef[]>> {
  const out = new Map<string, DocRef[]>();
  for (const d of await ctx.store.find<DocumentDoc>('documents', {}, { sort: { createdAt: 1 } })) {
    for (const l of d.links) if (l.domain === domain) out.set(l.recordId, [...(out.get(l.recordId) ?? []), docRef(d)]);
  }
  return out;
}

// ── validation ─────────────────────────────────────────────────────────

export async function checkLinks(input: unknown): Promise<DocLink[]> {
  if (!Array.isArray(input)) throw bad('invalid_value', 'links must be a list of { domain, recordId }');
  if (input.length > MAX_LINKS) throw bad('invalid_value', `Up to ${MAX_LINKS} links`);
  const out: DocLink[] = [];
  for (const raw of input as { domain?: unknown; recordId?: unknown }[]) {
    const domain = String(raw?.domain ?? ''), recordId = String(raw?.recordId ?? '');
    const rec = await ctx.store.get<{ _id: string; domain: string }>('records', recordId);
    if (!rec || rec.domain !== domain) throw bad('invalid_link', `No ${domain} entry ${recordId}`);
    if (!out.some((l) => l.recordId === recordId)) out.push({ domain, recordId });
  }
  return out;
}

export const parseLink = (s: string | undefined) => {
  if (!s) return [];
  const [domain, recordId] = s.split(':');
  return [{ domain, recordId }];
};

export function checkKind(k: unknown) {
  const s = String(k ?? '');
  if (!KIND_RE.test(s)) throw bad('invalid_value', 'kind: lowercase letters, digits and _');
  return s;
}
export function checkDate(v: unknown) {
  if (v === null || v === '' || v === undefined) return null;
  if (!isPartialDate(v)) throw bad('invalid_value', 'date: use YYYY, YYYY-MM or YYYY-MM-DD');
  return v as string;
}
export function checkText(v: unknown) {
  const s = String(v ?? '');
  if (s.length > MAX_TEXT) throw bad('invalid_value', 'text is too long');
  return s ? encrypt(ctx.keys.masterKey, s) : '';
}

export async function defaultKind(links: DocLink[]) {
  const d = links[0] ? await getDomain(links[0].domain) : null;
  return d?.documents ?? 'other';
}

// ── lifecycle ──────────────────────────────────────────────────────────

export async function createDocument(input: { title: string; kind?: string; status?: string; date?: string; links: DocLink[]; page: FileDoc; from: Source }) {
  const links = await checkLinks(input.links);
  const t = new Date().toISOString();
  const doc: DocumentDoc = {
    _id: newId('doc'),
    title: input.title.trim().slice(0, 200) || 'Document',
    kind: input.kind ? checkKind(input.kind) : await defaultKind(links),
    status: input.status === 'inbox' || input.status === 'filed' ? input.status : links.length ? 'filed' : 'inbox',
    date: checkDate(input.date), pages: [fileRef(input.page)], links, text: '', notes: '', from: input.from, suggestions: [], createdAt: t, updatedAt: t,
  };
  await ctx.store.insert('documents', doc);
  await ctx.store.update('files', input.page._id, { documentId: doc._id });
  return doc;
}

export async function addPage(doc: DocumentDoc, page: FileDoc) {
  if (doc.pages.length >= MAX_PAGES) throw bad('too_many_pages', `Up to ${MAX_PAGES} pages`);
  await ctx.store.update('files', page._id, { documentId: doc._id });
  const pages = [...doc.pages, fileRef(page)];
  await ctx.store.update('documents', doc._id, { pages, updatedAt: new Date().toISOString() });
  return { ...doc, pages };
}

export async function removePage(doc: DocumentDoc, fileId: string) {
  if (!doc.pages.some((p) => p.id === fileId)) throw notFound('page_not_found');
  if (doc.pages.length === 1) throw new HttpError(409, 'last_page', 'A document needs at least one page. Delete the document instead.');
  await deleteFile(fileId);
  const pages = doc.pages.filter((p) => p.id !== fileId);
  await ctx.store.update('documents', doc._id, { pages, updatedAt: new Date().toISOString() });
  return { ...doc, pages };
}

export async function deleteDocument(doc: DocumentDoc) {
  for (const p of doc.pages) await deleteFile(p.id);
  await ctx.store.removeMany('shares', { documentId: doc._id });
  await ctx.store.remove('documents', doc._id);
}

/**
 * A record is going away: documents linked only to it go too (a receipt's photo);
 * documents linked elsewhere just lose this link. Returns how many were deleted.
 */
export async function recordRemoved(recordId: string) {
  let deleted = 0;
  for (const d of await ctx.store.find<DocumentDoc>('documents')) {
    if (!d.links.some((l) => l.recordId === recordId)) continue;
    const links = d.links.filter((l) => l.recordId !== recordId);
    if (links.length) await ctx.store.update('documents', d._id, { links, updatedAt: new Date().toISOString() });
    else { await deleteDocument(d); deleted++; }
  }
  return deleted;
}

export async function linkDocument(doc: DocumentDoc, link: DocLink) {
  if (doc.links.some((l) => l.recordId === link.recordId)) return doc;
  const links = [...doc.links, link];
  await ctx.store.update('documents', doc._id, { links, status: 'filed', updatedAt: new Date().toISOString() });
  return { ...doc, links, status: 'filed' as const };
}

// ── suggestions from assistants ─────────────────────────────────────────

export async function checkSuggestion(input: Record<string, unknown>, by: Source): Promise<Suggestion> {
  const d = await getDomain(String(input.domain ?? ''));
  if (!d) throw bad('invalid_value', 'domain: no such category');
  const recordId = input.recordId ? String(input.recordId) : null;
  if (recordId) {
    const rec = await ctx.store.get<{ _id: string; domain: string }>('records', recordId);
    if (!rec || rec.domain !== d.id) throw bad('invalid_value', `No ${d.id} entry ${recordId}`);
  }
  const data = (input.data ?? {}) as Record<string, unknown>;
  if (typeof data !== 'object' || Array.isArray(data)) throw bad('invalid_value', 'data must be an object');
  const unknownKeys = Object.keys(data).filter((k) => !d.parts.some((p) => p.key === k));
  if (unknownKeys.length) throw bad('unknown_parts', `${d.label} has no ${unknownKeys.join(', ')}`);
  return {
    id: newId('sug'), domain: d.id, recordId, data,
    ...(d.dated ? { validFrom: (input.validFrom as string) ?? null, validTo: (input.validTo as string) ?? null } : {}),
    note: String(input.note ?? '').slice(0, 1000), by, at: new Date().toISOString(),
  };
}

export async function addSuggestion(doc: DocumentDoc, s: Suggestion) {
  if (doc.suggestions.length >= MAX_SUGGESTIONS) throw bad('too_many_suggestions', 'This document already has suggestions waiting');
  const suggestions = [...doc.suggestions, s];
  await ctx.store.update('documents', doc._id, { suggestions, updatedAt: new Date().toISOString() });
  return { ...doc, suggestions };
}

export async function dropSuggestion(doc: DocumentDoc, sid: string) {
  const suggestions = doc.suggestions.filter((s) => s.id !== sid);
  await ctx.store.update('documents', doc._id, { suggestions, updatedAt: new Date().toISOString() });
  return { ...doc, suggestions };
}

/** Kinds for clients, plus which domains take documents and their default kind. */
export async function documentKinds() {
  return { kinds: DOC_KINDS, domains: (await listDomains()).filter((d) => d.documents).map((d) => ({ domain: d.id, label: d.label, kind: d.documents })) };
}
