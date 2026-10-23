/**
 * Big Dipper, the optional companion service. One connection, separate opt-in services.
 * Big Dipper doesn't exist yet: until LD_BIG_DIPPER_URL is set, owners can choose services and we keep the choice.
 */
import type { FastifyInstance } from 'fastify';
import { ctx } from '../ctx.js';
import { config } from '../config.js';
import { audit, ownerActor } from '../audit.js';
import { bad, HttpError, requireOwner } from '../auth.js';
import { displayAddr, getNode } from '../node.js';
import type { LinkDoc } from '../federation.js';
import { requestConnection } from './contacts.js';

const SERVICES = [
  {
    key: 'interface', title: 'Interface checks', tagline: 'Proof your Little Dipper speaks the standard',
    forYou: ['Problems are caught before contacts or apps run into them', 'A report in Messages after every check and every update'],
    forOthers: ['Apps, assistants and other nodes can see an “Interface checked” mark with the date', 'They can rely on your node without testing it themselves'],
    sees: 'Only the endpoints any contact or visitor can already reach.',
  },
  {
    key: 'upgrades', title: 'Managed upgrades', tagline: 'Stay current and secure without thinking about it',
    forYou: ['Each release is tested against the standard before it reaches you', 'You choose how much happens automatically, and can see what changed'],
    forOthers: ['Your contacts are talking to a current, patched node', 'Fewer broken connections after releases'],
    sees: 'Your Little Dipper’s version. Your node pulls updates itself; Big Dipper never pushes code or gets admin access.',
  },
  {
    key: 'identity', title: 'ID verification', tagline: 'Prove who you are once, without handing over documents again',
    forYou: ['Verify once, reuse it whenever someone needs to know it’s really you', 'Every request to see your result comes to you here, and nothing is shared without your yes'],
    forOthers: ['Landlords, employers and businesses get a trusted answer: verified, and the current profile matches', 'They see only the claims they need, and never have to collect or store your ID documents'],
    sees: 'Your ID documents during the check only. They are deleted afterwards; Big Dipper keeps the result and salted hashes.',
  },
];
const UPGRADE_MODES = [
  { key: 'notify', title: 'Tell me', text: 'You decide when to install each release.' },
  { key: 'security', title: 'Auto-apply security fixes', text: 'Security fixes install on their own; you decide on everything else.' },
  { key: 'all', title: 'Auto-apply everything', text: 'Every tested release installs on its own.' },
];
const PROMISES = [
  'Connecting gives Big Dipper your node ID and address, nothing else. A service asks for more only when you start it.',
  'Each service is separate. Turn any one off, or disconnect to end them all.',
  'Big Dipper reaches your node only the way any contact can. It never gets admin access.',
  'Optional. Little Dipper works fully without it.',
];

const norm = (u: string) => u.replace(/\/+$/, '');

async function bigDipperLink() {
  const url = config.bigDipperUrl;
  if (!url) return undefined;
  return (await ctx.store.find<LinkDoc>('nodeLinks', {})).find((l) => norm(l.peerUrl) === url);
}

function checkChoices(b: { services?: unknown; upgrades?: unknown }) {
  const services = Array.isArray(b.services) ? [...new Set(b.services.map(String))] : [];
  const unknown = services.find((k) => !SERVICES.some((s) => s.key === k));
  if (unknown) throw bad('invalid_value', `Unknown Big Dipper service ${unknown}`);
  const upgrades = b.upgrades === undefined ? 'security' : String(b.upgrades);
  if (!UPGRADE_MODES.some((m) => m.key === upgrades)) throw bad('invalid_value', `Unknown upgrade mode ${upgrades}`);
  return { services, upgrades };
}

async function saveChoices(keyId: string, choice: { services: string[]; upgrades: string }) {
  const n = await getNode();
  await ctx.store.update('nodes', n._id, { bigDipper: { ...choice, updatedAt: new Date().toISOString() } });
  const names = choice.services.map((k) => SERVICES.find((s) => s.key === k)!.title);
  await audit({ actor: ownerActor(keyId), action: 'bigdipper.services', resource: 'big-dipper', text: names.length ? `You chose Big Dipper services: ${names.join(', ')}` : 'You turned off all Big Dipper services', tone: 'owner' });
}

export default async function bigDipperRoutes(app: FastifyInstance) {
  app.get('/api/v1/big-dipper', async (req) => {
    await requireOwner(req, 'contacts:read');
    const n = await getNode();
    const link = await bigDipperLink();
    const url = config.bigDipperUrl;
    return {
      available: !!url,
      url: url || null,
      address: url ? displayAddr(url) : null,
      contact: link ? { contactId: link.contactId, status: link.status } : null,
      chosen: n.bigDipper?.services ?? [],
      upgrades: n.bigDipper?.upgrades ?? 'security',
      choseAt: n.bigDipper?.updatedAt ?? null,
      services: SERVICES,
      upgradeModes: UPGRADE_MODES,
      promises: PROMISES,
    };
  });

  /** Save which services the owner wants. A consent choice, so only the owner's own session. */
  app.put('/api/v1/big-dipper', async (req) => {
    const p = await requireOwner(req, 'contacts:write');
    if (!p.isSession) throw bad('session_required');
    const choice = checkChoices((req.body || {}) as object);
    await saveChoices(p.key._id, choice);
    return { ok: true, ...choice };
  });

  /** Save the choice and send Big Dipper a connection request that names it. Big Dipper gets no profile grant. */
  app.post('/api/v1/big-dipper/connect', async (req, reply) => {
    const p = await requireOwner(req, 'contacts:write');
    if (!p.isSession) throw bad('session_required');
    const choice = checkChoices((req.body || {}) as object);
    if (!choice.services.length) throw bad('invalid_value', 'Choose at least one service');
    if (!config.bigDipperUrl) throw new HttpError(409, 'big_dipper_unavailable', 'Big Dipper isn’t open yet. Your choices are saved.');
    await saveChoices(p.key._id, choice);
    const names = choice.services.map((k) => {
      const s = SERVICES.find((x) => x.key === k)!;
      return k === 'upgrades' ? `${s.title} (${UPGRADE_MODES.find((m) => m.key === choice.upgrades)!.title.toLowerCase()})` : s.title;
    });
    const out = await requestConnection(p.key._id, config.bigDipperUrl, [], `Services: ${names.join(', ')}`, false);
    reply.code(202);
    return out;
  });
}
