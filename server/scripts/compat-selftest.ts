/** Proves the compatibility check catches each kind of break and lets additions through. Runs in CI before the check itself. */
import { readFileSync } from 'node:fs';
import { breaks } from './compat.js';
const was = JSON.parse(readFileSync(new URL('../compat/contract.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(was);
const cases: [string, (c: any) => void, boolean][] = [
  ['remove part', (c) => delete c.domains.employment.parts.title, true],
  ['rename part', (c) => { c.domains.employment.parts.jobTitle = c.domains.employment.parts.title; delete c.domains.employment.parts.title; }, true],
  ['retype part', (c) => c.domains.employment.parts.title.type = 'longtext', true],
  ['remove domain', (c) => delete c.domains.pets, true],
  ['new required part', (c) => c.domains.pets.parts.chip = { type: 'text', required: true }, true],
  ['optional -> required', (c) => { const k = Object.keys(c.domains.pets.parts).find((k) => !c.domains.pets.parts[k].required)!; c.domains.pets.parts[k].required = true; }, true],
  ['remove enum option', (c) => c.domains.names.parts.kind.options.pop(), true],
  ['remove list sub-part', (c) => { const l = Object.values(c.domains.receipts.parts).find((p: any) => p.of) as any; delete l.of[Object.keys(l.of)[0]]; }, true],
  ['remove capability', (c) => c.capabilities.pop(), true],
  ['remove route', (c) => c.routes.pop(), true],
  ['add optional part', (c) => c.domains.pets.parts.chip = { type: 'text', required: false }, false],
  ['add domain', (c) => c.domains.boats = { dated: true, parts: { name: { type: 'text', required: true } } }, false],
  ['add enum option', (c) => c.domains.names.parts.kind.options.push('stage'), false],
  ['add capability + route', (c) => { c.capabilities.push('x'); c.routes.push('GET /api/x'); }, false],
  ['mark deprecated', (c) => c.domains.employment.parts.title.deprecated = true, false],
];
let bad = 0;
for (const [name, edit, shouldFail] of cases) {
  const now = clone(); edit(now);
  const p = breaks(was, now);
  const ok = shouldFail ? p.length > 0 : p.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${name}${p[0] ? ` → ${p[0]}` : ' → passes'}`);
}
process.exit(bad ? 1 : 0);
