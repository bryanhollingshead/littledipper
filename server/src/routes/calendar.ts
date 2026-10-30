/**
 * GET /api/v1/calendar: everything on the owner's calendar between two dates. Served here so any
 * skin can build the same view (Commandment XI); the logic lives in calendar.ts.
 */
import type { FastifyInstance } from 'fastify';
import { bad, requireOwner } from '../auth.js';
import { calendarItems } from '../calendar.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;

export default async function calendarRoutes(app: FastifyInstance) {
  app.get('/api/v1/calendar', async (req) => {
    const p = await requireOwner(req, ['records:read', 'events:read']);
    const q = req.query as { from?: string; to?: string };
    if (!DAY.test(q.from ?? '') || !DAY.test(q.to ?? '')) throw bad('invalid_range', 'Give from and to as YYYY-MM-DD');
    const span = (Date.parse(q.to!) - Date.parse(q.from!)) / 86400_000;
    if (!(span >= 0 && span <= MAX_DAYS)) throw bad('invalid_range', `from must be on or before to, at most ${MAX_DAYS} days apart`);
    // An events-only key sees just events; contacts' shared events need contacts:read.
    const can = (s: string) => p.key.scopes.includes('admin:*') || p.key.scopes.includes(s);
    let items = await calendarItems(q.from!, q.to!, { contacts: can('contacts:read') });
    if (!can('records:read')) items = items.filter((i) => i.domain === 'events' && !i.contact);
    return { from: q.from, to: q.to, items };
  });
}
