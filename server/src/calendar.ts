/**
 * The calendar: the owner's events, the dates their data already holds (birthdays, trips, life
 * events, return-by and warranty deadlines, expiries, any date-and-time part) and the events
 * contacts share with them. A read-only view over records; nothing is stored here.
 */
import { ctx } from './ctx.js';
import type { ContactDoc } from './federation.js';
import { isDateTime, normalizeDateTime, type DateTimeValue } from './domains/datetime.js';
import { isCurrent, isPartialDate, listDomains, plainData, recordOut, recordsOf } from './domains/records.js';
import type { DomainDef } from './domains/types.js';

export type CalendarItem = {
  /** Unique per occurrence: a repeating event has one item per day it happens. */
  id: string;
  kind: 'event' | 'birthday' | 'trip' | 'milestone' | 'deadline' | 'expiry' | 'moment';
  title: string;
  /** A second line: "turns 40", the part a deadline belongs to… */
  detail?: string;
  /** Local dates covered, inclusive (YYYY-MM-DD). For timed items, in the item's own zone. */
  startDate: string;
  endDate: string;
  allDay: boolean;
  /** Timed items only. */
  start?: DateTimeValue;
  end?: DateTimeValue;
  location?: string;
  repeat?: string;
  domain: string;
  domainLabel: string;
  recordId: string;
  /** Shared by a contact, not the owner's own. */
  contact?: { id: string; name: string };
};

const DAY = 86400_000;
const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const addDays = (d: string, n: number) => ymd(dayMs(d) + n * DAY);
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** A partial date as the last day of its period: 2027 → 2027-12-31, 2027-04 → 2027-04-30. */
function lastDay(v: string) {
  if (v.length === 4) return `${v}-12-31`;
  if (v.length === 7) return `${v}-${pad(daysInMonth(+v.slice(0, 4), +v.slice(5, 7) - 1))}`;
  return v;
}

/** The nth repeat of a wall-clock time ("2026-01-31T09:00:00"); month ends and Feb 29 clamp to the last day. */
function nth(wall: string, repeat: string, n: number) {
  const y = +wall.slice(0, 4), m = +wall.slice(5, 7) - 1, d = +wall.slice(8, 10), time = wall.slice(10);
  let date: string;
  if (repeat === 'daily' || repeat === 'weekly') date = ymd(Date.UTC(y, m, d) + n * (repeat === 'daily' ? 1 : 7) * DAY);
  else {
    const months = repeat === 'monthly' ? m + n : m, years = repeat === 'yearly' ? y + n : y;
    const yy = years + Math.floor(months / 12), mm = ((months % 12) + 12) % 12;
    date = `${yy}-${pad(mm + 1)}-${pad(Math.min(d, daysInMonth(yy, mm)))}`;
  }
  return date + time;
}

/** Every occurrence of one event (repeating or not) that touches [from, to]. */
function occurrences(base: Omit<CalendarItem, 'id' | 'startDate' | 'endDate' | 'start' | 'end'>, data: Record<string, unknown>, from: string, to: string): CalendarItem[] {
  const start = normalizeDateTime(data.start);
  if (!start) return [];
  const end = normalizeDateTime(data.end);
  const allDay = data.allDay === true;
  const repeat = ['daily', 'weekly', 'monthly', 'yearly'].includes(String(data.repeat)) ? String(data.repeat) : '';
  const until = isPartialDate(data.repeatUntil) ? lastDay(String(data.repeatUntil)) : null;
  // How long one occurrence lasts: whole days when all day, otherwise time (an hour if no end).
  const spanDays = allDay && end ? Math.max(0, (dayMs(end.at.slice(0, 10)) - dayMs(start.at.slice(0, 10))) / DAY) : 0;
  const spanMs = !allDay && end ? Date.parse(end.at) - Date.parse(start.at) : 3600_000;
  const out: CalendarItem[] = [];
  const wall = start.at.slice(0, 19);
  for (let n = 0; n < (repeat ? 20000 : 1); n++) {
    const s = normalizeDateTime({ at: repeat ? nth(wall, repeat, n) : wall, tz: start.tz });
    if (!s) break;
    const sDate = s.at.slice(0, 10);
    if (sDate > to || (until && sDate > until)) break;
    const e = allDay ? null : normalizeDateTime({ at: new Date(Date.parse(s.at) + spanMs).toISOString(), tz: start.tz });
    const eDate = allDay ? addDays(sDate, spanDays) : e!.at.slice(0, 10);
    if (eDate < from) continue;
    out.push({ ...base, id: `${base.recordId}:${sDate}`, startDate: sDate, endDate: eDate, allDay, ...(allDay ? {} : { start: s, end: e! }), ...(repeat ? { repeat } : {}) });
  }
  return out;
}

/** Everything on the calendar between two local dates, inclusive. */
export async function calendarItems(from: string, to: string, opts: { contacts: boolean }): Promise<CalendarItem[]> {
  const items: CalendarItem[] = [];
  const domains = await listDomains();
  const base = (d: DomainDef, recordId: string) => ({ domain: d.id, domainLabel: d.label, recordId });
  const inRange = (s: string, e: string = s) => e >= from && s <= to;

  for (const d of domains) {
    const recs = await recordsOf(d.id);
    if (!recs.length) continue;
    for (const r of recs) {
      const x = plainData(r);
      const title = recordOut(d, r).title;
      if (d.id === 'events') {
        items.push(...occurrences({ ...base(d, r._id), kind: 'event', title, allDay: false, ...(x.location ? { location: String(x.location) } : {}) }, x, from, to));
        continue;
      }
      // Birthdays, every year, for people and pets with a full birth date.
      if ((d.id === 'relationships' || d.id === 'pets') && isDay(x.birthDate) && isCurrent(d, r)) {
        const born = x.birthDate as string;
        for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) {
          if (y < +born.slice(0, 4)) continue;
          const day = `${y}-${born.slice(5, 7)}-${pad(Math.min(+born.slice(8, 10), daysInMonth(y, +born.slice(5, 7) - 1)))}`;
          const age = y - +born.slice(0, 4);
          if (inRange(day)) items.push({ ...base(d, r._id), id: `${r._id}:birthday:${y}`, kind: 'birthday', title: `${x.name ?? title}’s birthday`, ...(age ? { detail: `turns ${age}` } : {}), startDate: day, endDate: day, allDay: true });
        }
      }
      // Trips span their days; life events sit on theirs. Only when the record knows the day.
      if ((d.id === 'travel' || d.id === 'life_events') && isDay(r.validFrom)) {
        const end = d.id === 'travel' && isDay(r.validTo) && r.validTo >= r.validFrom ? r.validTo : r.validFrom;
        if (inRange(r.validFrom, end)) items.push({ ...base(d, r._id), id: `${r._id}:${d.id}`, kind: d.id === 'travel' ? 'trip' : 'milestone', title, startDate: r.validFrom, endDate: end, allDay: true });
      }
      for (const p of d.parts) {
        const v = x[p.key];
        // Deadlines and expiries on current records, as on Home's "Coming up".
        if (p.type === 'date' && (p.remind || /expires/i.test(p.key)) && isPartialDate(v) && isCurrent(d, r)) {
          const day = lastDay(v as string);
          if (inRange(day)) items.push({ ...base(d, r._id), id: `${r._id}:${p.key}`, kind: p.remind ? 'deadline' : 'expiry', title, detail: p.label, startDate: day, endDate: day, allDay: true });
        }
        // Any other date-and-time part (a custom "Appointments" category…) is a moment on the calendar.
        if (p.type === 'datetime' && isDateTime(v)) {
          const day = v.at.slice(0, 10);
          if (inRange(day)) items.push({ ...base(d, r._id), id: `${r._id}:${p.key}`, kind: 'moment', title, detail: p.label, startDate: day, endDate: day, allDay: false, start: v, end: v });
        }
      }
    }
  }

  // Events contacts share with us, as last synced from their nodes. Their data is theirs: shape-checked, never trusted.
  if (opts.contacts) {
    for (const c of await ctx.store.find<ContactDoc>('contacts', { kind: 'node' })) {
      const shared = (c.sharedDomains || []).find((s) => s.domain === 'events');
      if (!shared) continue;
      for (const r of shared.records) {
        items.push(...occurrences({
          kind: 'event', title: String(r.title).slice(0, 200), allDay: false, domain: 'events', domainLabel: shared.label, recordId: String(r.id),
          contact: { id: c._id, name: c.displayName }, ...(typeof r.data?.location === 'string' ? { location: r.data.location.slice(0, 200) } : {}),
        }, (r.data || {}) as Record<string, unknown>, from, to).map((i) => ({ ...i, id: `${c._id}:${i.id}` })));
      }
    }
  }

  const when = (i: CalendarItem) => (i.allDay ? '' : new Date(i.start!.at).toISOString());
  return items.sort((a, b) => a.startDate.localeCompare(b.startDate) || Number(b.allDay) - Number(a.allDay) || when(a).localeCompare(when(b)) || a.title.localeCompare(b.title));
}
