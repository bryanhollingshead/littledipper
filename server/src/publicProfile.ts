/**
 * The public profile as sections the owner adds, orders and configures: details (profile fields),
 * an about paragraph, entries from publicable domains (work history, education…) and a résumé document.
 * One function builds what visitors see, so the owner's preview is the real thing.
 */
import { ctx } from './ctx.js';
import { bad } from './auth.js';
import { allFields, plainValue } from './fields.js';
import type { PublicProfileDoc } from './federation.js';
import type { DocumentDoc } from './documents.js';
import type { FileDoc } from './files.js';
import { displayValue, getDomain, isCurrent, partSens, plainData, recordsOf, renderTitle, sortRecords, type DomainDef, type PartDef } from './domains/records.js';

export type PublicSection =
  | { type: 'details' }
  | { type: 'about'; text: string }
  | { type: 'domain'; domain: string; title?: string; parts: string[]; scope: 'all' | 'current'; hidden: string[] }
  | { type: 'resume'; documentId: string; title?: string };

const MAX_SECTIONS = 12;

const TITLES: Record<string, string> = { employment: 'Work history', education: 'Education', credentials: 'Licenses & certifications', military: 'Military service' };
/** What a new section shows until the owner changes it: the parts a résumé would. */
const DEFAULT_PARTS: Record<string, string[]> = {
  employment: ['title', 'employer', 'type', 'city', 'country', 'remote', 'description'],
  education: ['institution', 'degree', 'field', 'honors'],
  credentials: ['name', 'issuer', 'kind', 'region', 'issued', 'expires', 'url'],
  military: ['branch', 'rank', 'country', 'discharge'],
};

/** Never public: secret parts, links to the owner's contacts, and lists. */
export const publicParts = (d: DomainDef) => d.parts.filter((p) => partSens(d, p) !== 'secret' && p.type !== 'contact' && p.type !== 'list');
export const defaultParts = (d: DomainDef) => (DEFAULT_PARTS[d.id] ?? publicParts(d).map((p) => p.key)).filter((k) => publicParts(d).some((p) => p.key === k));
export const sectionsOf = (pp: PublicProfileDoc): PublicSection[] => pp.sections ?? [{ type: 'details' }];

export async function checkSections(input: unknown): Promise<PublicSection[]> {
  if (!Array.isArray(input)) throw bad('invalid_value', 'sections must be a list');
  if (input.length > MAX_SECTIONS) throw bad('invalid_value', `Up to ${MAX_SECTIONS} sections`);
  const out: PublicSection[] = [];
  for (const raw of input as Record<string, unknown>[]) {
    switch (raw?.type) {
      case 'details':
        if (out.some((s) => s.type === 'details')) throw bad('invalid_value', 'Only one details section');
        out.push({ type: 'details' });
        break;
      case 'about':
        out.push({ type: 'about', text: String(raw.text ?? '').slice(0, 3000) });
        break;
      case 'domain': {
        const d = await getDomain(String(raw.domain ?? ''));
        if (!d || !d.publicable) throw bad('not_publicable', `${d?.label ?? String(raw.domain)} can’t be on your public profile`);
        if (out.some((s) => s.type === 'domain' && s.domain === d.id)) throw bad('invalid_value', `${d.label} is already a section`);
        const allowed = new Set(publicParts(d).map((p) => p.key));
        const parts = raw.parts === undefined ? defaultParts(d) : (raw.parts as unknown[]).map(String);
        const bad1 = parts.find((k) => !allowed.has(k));
        if (bad1) throw bad('secret_never_public', `${d.label}: ${d.parts.find((p) => p.key === bad1)?.label ?? bad1} can’t be public`);
        out.push({
          type: 'domain', domain: d.id, title: raw.title ? String(raw.title).slice(0, 80) : undefined, parts: [...new Set(parts)],
          scope: raw.scope === 'current' ? 'current' : 'all', hidden: Array.isArray(raw.hidden) ? (raw.hidden as unknown[]).map(String).slice(0, 500) : [],
        });
        break;
      }
      case 'resume': {
        const doc = await ctx.store.get<DocumentDoc>('documents', String(raw.documentId ?? ''));
        if (!doc) throw bad('invalid_value', 'Résumé: no such document');
        out.push({ type: 'resume', documentId: doc._id, title: raw.title ? String(raw.title).slice(0, 80) : undefined });
        break;
      }
      default:
        throw bad('invalid_value', `Unknown section type ${String(raw?.type)}`);
    }
  }
  return out;
}

export const publicFileUrl = (id: string) => `/public/v1/profile/files/${id}`;

/** Detail fields: Standard and Sensitive the owner switched on, with values. */
export async function publicFields(pp: PublicProfileDoc) {
  const fields = await allFields();
  return pp.fieldKeys
    .map((k) => fields.find((f) => f.key === k))
    .filter((f) => f && f.sensitivity !== 'secret' && plainValue(f))
    .map((f) => ({ key: f!.key, label: f!.label, value: plainValue(f!) }));
}

async function domainItems(s: Extract<PublicSection, { type: 'domain' }>) {
  const d = await getDomain(s.domain);
  if (!d || !d.publicable) return null;
  const shown = publicParts(d).filter((p) => s.parts.includes(p.key));
  const titleKeys = new Set([...d.title.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  const recs = sortRecords(d, await recordsOf(d.id)).filter((r) => !s.hidden.includes(r._id) && (s.scope === 'all' || isCurrent(d, r)));
  return {
    type: 'domain' as const, domain: d.id, title: s.title || TITLES[d.id] || d.label, dated: d.dated,
    items: recs.map((r) => {
      const plain = plainData(r);
      const values = Object.fromEntries(shown.filter((p) => plain[p.key] !== undefined).map((p) => [p.key, plain[p.key]]));
      const fields = shown.filter((p: PartDef) => !titleKeys.has(p.key) && values[p.key] !== undefined)
        .map((p) => ({ key: p.key, label: p.label, type: p.type, value: displayValue(p, values[p.key]) }))
        .filter((f) => f.value);
      return { id: r._id, title: renderTitle(d, values), fields, validFrom: r.validFrom, validTo: r.validTo, current: isCurrent(d, r) };
    }),
  };
}

async function liveFile(id: string | null) {
  return id && (await ctx.store.get<FileDoc>('files', id)) ? id : null;
}

/** Exactly what visitors get. */
export async function publicView(pp: PublicProfileDoc) {
  const sections = [];
  for (const s of sectionsOf(pp)) {
    if (s.type === 'details') sections.push({ type: 'details' as const, fields: await publicFields(pp) });
    else if (s.type === 'about') { if (s.text.trim()) sections.push({ type: 'about' as const, text: s.text }); }
    else if (s.type === 'domain') { const v = await domainItems(s); if (v && v.items.length) sections.push(v); }
    else if (s.type === 'resume') {
      const doc = await ctx.store.get<DocumentDoc>('documents', s.documentId);
      if (doc) sections.push({ type: 'resume' as const, title: s.title || 'Résumé', document: { title: doc.title, updatedAt: doc.updatedAt, pages: doc.pages.map((p) => ({ ...p, url: publicFileUrl(p.id) })) } });
    }
  }
  const avatar = await liveFile(pp.avatarFileId);
  return { displayName: pp.displayName, headline: pp.headline, avatarUrl: avatar ? publicFileUrl(avatar) : null, sections };
}

/** Files a visitor may open: the photo and the pages of résumé sections. */
export async function publicFileIds(pp: PublicProfileDoc) {
  const ids = new Set<string>();
  if (pp.avatarFileId) ids.add(pp.avatarFileId);
  for (const s of sectionsOf(pp)) {
    if (s.type !== 'resume') continue;
    const doc = await ctx.store.get<DocumentDoc>('documents', s.documentId);
    doc?.pages.forEach((p) => ids.add(p.id));
  }
  return ids;
}
