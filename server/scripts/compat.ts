/**
 * The compatibility check (docs/COMPATIBILITY.md, Commandments II, VII and X).
 *
 * compat/contract.json records what other parties depend on: the built-in catalog, the capability
 * list and every route. This script builds the same thing from the code and compares:
 *
 *   npm run compat                    code vs. the committed contract (must match; additions need --update)
 *   npm run compat -- --base <ref>    also: nothing in <ref>'s contract was removed or changed
 *   npm run compat -- --update        rewrite the contract from the code (additions only, still checked)
 *
 * CI passes the commit being built on as --base, so editing contract.json can't hide a removal.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';
import { BUILT_IN_DOMAINS } from '../src/domains/catalog.js';
import type { PartDef } from '../src/domains/types.js';
import { CAPABILITIES } from '../src/node.js';

type Part = { type: string; required: boolean; deprecated?: true; options?: string[]; of?: Record<string, Part> };
type Contract = { capabilities: string[]; routes: string[]; domains: Record<string, { dated: boolean; parts: Record<string, Part> }> };

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../compat/contract.json');
const REPO_PATH = 'server/compat/contract.json';

function partsOf(parts: PartDef[]): Record<string, Part> {
  return Object.fromEntries(parts.map((p) => [p.key, {
    type: p.type,
    required: !!p.required,
    ...(p.deprecated ? { deprecated: true as const } : {}),
    ...(p.options ? { options: p.options.map(([k]) => k) } : {}),
    ...(p.of ? { of: partsOf(p.of) } : {}),
  }]));
}

async function current(): Promise<Contract> {
  const routes = new Set<string>();
  // Route parameter names aren't part of the URL, so /x/:id and /x/:recordId are the same route.
  const app = await buildApp({ onRoute: (m, url) => { if (m !== 'HEAD') routes.add(`${m} ${url.replace(/:[A-Za-z_]+/g, '{}')}`); } });
  await app.close();
  return {
    capabilities: [...CAPABILITIES].sort(),
    routes: [...routes].sort(),
    domains: Object.fromEntries(BUILT_IN_DOMAINS.map((d) => [d.id, { dated: d.dated, parts: partsOf(d.parts) }])),
  };
}

/** Everything in `was` that `now` breaks. Additions are fine. */
export function breaks(was: Contract, now: Contract): string[] {
  const out: string[] = [];
  for (const c of was.capabilities) if (!now.capabilities.includes(c)) out.push(`Capability \`${c}\` was removed. A capability is never withdrawn (VII).`);
  for (const r of was.routes) if (!now.routes.includes(r)) out.push(`\`${r}\` was removed or renamed. Endpoints only get added (II).`);
  for (const [id, d] of Object.entries(was.domains)) {
    const n = now.domains[id];
    if (!n) { out.push(`Domain \`${id}\` was removed. Built-in domains are never removed (catalog rule).`); continue; }
    if (n.dated !== d.dated) out.push(`Domain \`${id}\` changed \`dated\`. Records would change shape (catalog rule).`);
    parts(`${id}`, d.parts, n.parts, out);
  }
  return out;
}

function parts(at: string, was: Record<string, Part>, now: Record<string, Part>, out: string[]) {
  for (const [key, p] of Object.entries(was)) {
    const name = `${at}.${key}`, n = now[key];
    if (!n) { out.push(`Part \`${name}\` was removed or renamed. Mark it \`deprecated: true\` and add the new part next to it (catalog rule).`); continue; }
    if (n.type !== p.type) out.push(`Part \`${name}\` changed type from ${p.type} to ${n.type}. Add a new part instead (catalog rule).`);
    if (n.required !== p.required) out.push(`Part \`${name}\` became ${n.required ? 'required' : 'optional'}. Existing records and clients rely on it staying ${p.required ? 'required' : 'optional'} (catalog rule).`);
    for (const o of p.options || []) if (!n.options?.includes(o)) out.push(`Option \`${o}\` was removed from \`${name}\`. Existing records may hold it (catalog rule).`);
    if (p.of) parts(`${name}[]`, p.of, n.of || {}, out);
  }
  // A new part on a domain that already exists can't be required: old records don't have it.
  for (const [key, n] of Object.entries(now)) if (!was[key] && n.required) out.push(`New part \`${at}.${key}\` is required. Records saved before it can't have it, so new parts are optional (catalog rule).`);
}

const fromRef = (ref: string): Contract | null => {
  try { return JSON.parse(execFileSync('git', ['show', `${ref}:${REPO_PATH}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
};

async function main() {
  const args = process.argv.slice(2);
  const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;
  const now = await current();
  const committed: Contract | null = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : null;

  const problems: string[] = [];
  if (committed) problems.push(...breaks(committed, now));
  const baseline = base ? fromRef(base) : null;
  if (base && !baseline) console.log(`No contract at ${base} yet; checking against the committed one only.`);
  if (baseline) problems.push(...breaks(baseline, now).filter((p) => !problems.includes(p)));

  if (problems.length) {
    console.error(`\n✗ ${problems.length} breaking ${problems.length === 1 ? 'change' : 'changes'} (see docs/COMPATIBILITY.md):\n`);
    for (const p of problems) console.error(`  • ${p}`);
    console.error('\nAdditions are always fine. To change something, add the new thing next to the old one and keep the old one working.\n');
    process.exit(1);
  }

  const text = JSON.stringify(now, null, 2) + '\n';
  if (args.includes('--update')) {
    writeFileSync(FILE, text);
    console.log(`✓ Contract updated: ${now.capabilities.length} capabilities, ${now.routes.length} routes, ${Object.keys(now.domains).length} domains.`);
    return;
  }
  if (!committed || readFileSync(FILE, 'utf8') !== text) {
    console.error('\n✗ The code adds to the API or catalog, but server/compat/contract.json wasn\'t updated.\n  Run `npm run compat -- --update` and commit the result.\n');
    process.exit(1);
  }
  console.log(`✓ Compatible: ${now.capabilities.length} capabilities, ${now.routes.length} routes, ${Object.keys(now.domains).length} domains${baseline ? `, nothing removed since ${base}` : ''}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
