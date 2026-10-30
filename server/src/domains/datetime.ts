/**
 * datetime parts: a moment plus the IANA time zone it belongs to, stored as
 * { at: '2026-11-04T09:30:00-05:00', tz: 'America/New_York' }.
 *
 * `at` is always written as local time in `tz` with that zone's offset at that moment, so it
 * reads correctly as plain text, its first ten characters are the local date, and Date.parse
 * gives the exact instant. Input may leave the offset off ('2026-11-04T09:30'): that's wall-clock
 * time in `tz`, which is how people (and assistants) say it. Daylight saving is worked out here.
 */
export type DateTimeValue = { at: string; tz: string };

const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Wall-clock parts of an instant in a zone, and the zone's offset then in minutes east of UTC. */
function inZone(ms: number, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return { p, wall, offset: Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000) };
}

function write(ms: number, tz: string) {
  const { p, offset } = inZone(ms, tz);
  const a = Math.abs(offset);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** The stored form of a datetime input, or null if it isn't one. */
export function normalizeDateTime(v: unknown): DateTimeValue | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { at, tz } = v as { at?: unknown; tz?: unknown };
  if (typeof at !== 'string' || !isTimeZone(tz)) return null;
  let ms: number;
  if (WITH_OFFSET.test(at)) {
    ms = Date.parse(at);
  } else {
    const m = at.match(WALL_CLOCK);
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x ?? 0));
    const wall = Date.UTC(y, mo - 1, d, h, mi, s);
    const w = new Date(wall);
    if (w.getUTCFullYear() !== y || w.getUTCMonth() !== mo - 1 || w.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
    // Offsets in force a day either side cover any daylight-saving change. Keep the ones that give
    // back this wall-clock time: both in a repeated autumn hour (take the earlier instant), none in
    // an hour skipped in spring (use the offset from before, landing an hour later: 02:30 → 03:30),
    // as JavaScript's Temporal does.
    const before = inZone(wall - 86400_000, tz).offset, after = inZone(wall + 86400_000, tz).offset;
    const fits = [...new Set([before, after])].map((o) => wall - o * 60000).filter((t) => inZone(t, tz).wall === wall);
    ms = fits.length ? Math.min(...fits) : wall - before * 60000;
  }
  if (!Number.isFinite(ms)) return null;
  return { at: write(ms, tz), tz };
}

export function isDateTime(v: unknown): v is DateTimeValue {
  return !!v && typeof v === 'object' && typeof (v as DateTimeValue).at === 'string' && typeof (v as DateTimeValue).tz === 'string';
}

/** "Nov 4, 2026, 9:30 AM EST", in the value's own zone. */
export function displayDateTime(v: DateTimeValue) {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: v.tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(v.at));
  } catch { return v.at; }
}

/** Sorts by the actual instant: UTC ISO 8601. */
export const dateTimeSortKey = (v: DateTimeValue) => new Date(v.at).toISOString();
