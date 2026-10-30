import { useState, type CSSProperties } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get } from '../../api';
import { ErrorNote, Loading, Pills, useAction, useAsync } from '../../ui';
import { fetchCatalog, localZone, RecordEditor, useContactsLite, type DateTime, type Rec } from '../../life';

/** One thing on the calendar, as GET /api/v1/calendar returns it. */
export type CalItem = {
  id: string; kind: 'event' | 'birthday' | 'trip' | 'milestone' | 'deadline' | 'expiry' | 'moment';
  title: string; detail?: string; startDate: string; endDate: string; allDay: boolean;
  start?: DateTime; end?: DateTime; location?: string; repeat?: string;
  domain: string; domainLabel: string; recordId: string; contact?: { id: string; name: string };
};

// ── dates, in the viewer's own time ────────────────────────────────────
const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s: string) => new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +(s.slice(8, 10) || 1));
export const addDays = (s: string, n: number) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const addMonths = (m: string, n: number) => { const d = parse(`${m}-01`); d.setMonth(d.getMonth() + n); return ymd(d).slice(0, 7); };

/** The days an item covers here: timed items by their moment in the viewer's time, all-day ones as written. */
export function daysOf(i: CalItem): [string, string] {
  if (i.allDay || !i.start) return [i.startDate, i.endDate];
  const s = Date.parse(i.start.at), e = Math.max(s, Date.parse(i.end?.at ?? i.start.at) - 1); // ending at midnight stays on its day
  return [ymd(new Date(s)), ymd(new Date(e))];
}
export const timeOf = (at: string) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(at));
/** "6pm", "9:30am" where the locale uses AM/PM; "18:00" elsewhere. For tight spaces. */
const shortTime = (at: string) => timeOf(at).replace(/:00(?=\s?[AP]M)/i, '').replace(/\s?([AP])M/i, (_, x: string) => `${x.toLowerCase()}m`);

/** First day of the week for this browser's locale (0 = Sunday); Monday when the browser can't say. */
const WEEK_START = (() => {
  try {
    const l = new Intl.Locale(navigator.language) as unknown as { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = l.getWeekInfo?.() ?? l.weekInfo;
    return info ? info.firstDay % 7 : 1;
  } catch { return 1; }
})();

// ── how things look ────────────────────────────────────────────────────
type Look = { bg: string; ink: string; dot: string; border?: string; label: string };
/** Soft fills for what you plan and celebrate, a firmer one for what's about to run out. */
const LOOK: Record<CalItem['kind'] | 'shared', Look> = {
  event: { bg: 'var(--color-accent-200)', ink: 'var(--color-accent-900)', dot: 'var(--color-accent-600)', label: 'Event' },
  moment: { bg: 'var(--color-accent-100)', ink: 'var(--color-accent-800)', dot: 'var(--color-accent-400)', label: 'Appointment' },
  birthday: { bg: 'var(--color-accent-2-100)', ink: 'var(--color-accent-2-800)', dot: 'var(--color-accent-2-500)', label: 'Birthday' },
  trip: { bg: 'var(--color-accent-2-200)', ink: 'var(--color-accent-2-900)', dot: 'var(--color-accent-2-700)', label: 'Trip' },
  milestone: { bg: 'var(--color-neutral-200)', ink: 'var(--color-neutral-800)', dot: 'var(--color-neutral-600)', label: 'Life event' },
  deadline: { bg: 'var(--color-neutral-100)', ink: 'var(--color-accent-800)', dot: 'var(--color-accent-500)', border: '1.5px solid var(--color-accent-400)', label: 'Deadline' },
  expiry: { bg: 'var(--color-accent-700)', ink: 'var(--color-neutral-100)', dot: 'var(--color-accent-800)', label: 'Expires' },
  shared: { bg: 'transparent', ink: 'var(--color-accent-2-800)', dot: 'var(--color-accent-2-600)', border: '1px dashed var(--color-accent-2-500)', label: 'Shared with you' },
};
export const lookOf = (i: CalItem) => LOOK[i.contact ? 'shared' : i.kind];
/** What a chip says: deadlines and expiries say why they're on the calendar. */
export const labelOf = (i: CalItem) => (i.kind === 'deadline' && i.detail ? `${i.detail} · ${i.title}` : i.kind === 'expiry' ? `${i.title} expires` : i.title);

type Filter = 'mine' | 'shared' | 'birthday' | 'life' | 'due';
const FILTERS: [Filter, string][] = [['mine', 'My events'], ['shared', 'Shared with me'], ['birthday', 'Birthdays'], ['life', 'Trips & milestones'], ['due', 'Deadlines & expiries']];
const filterOf = (i: CalItem): Filter =>
  i.contact ? 'shared' : i.kind === 'event' || i.kind === 'moment' ? 'mine' : i.kind === 'birthday' ? 'birthday' : i.kind === 'trip' || i.kind === 'milestone' ? 'life' : 'due';
const FILTER_DOT: Record<Filter, string> = { mine: LOOK.event.dot, shared: LOOK.shared.dot, birthday: LOOK.birthday.dot, life: LOOK.trip.dot, due: LOOK.expiry.dot };

/** Calendar: your events beside the dates your data already holds, and what contacts share with you. */
export default function Calendar() {
  const navigate = useNavigate();
  const { run } = useAction();
  const contacts = useContactsLite();
  const [params, setParams] = useSearchParams();
  const today = ymd(new Date());
  const selected = /^\d{4}-\d{2}-\d{2}$/.test(params.get('d') ?? '') ? params.get('d')! : today;
  const month = /^\d{4}-\d{2}$/.test(params.get('m') ?? '') ? params.get('m')! : selected.slice(0, 7);
  const [view, setView] = useState<'month' | 'agenda'>('month');
  const [hidden, setHidden] = useState<Set<Filter>>(new Set());
  const [editing, setEditing] = useState<Rec | 'new' | null>(null);
  const [version, setVersion] = useState(0);

  // The visible weeks: from the week the month starts in to the week it ends in.
  const first = `${month}-01`;
  const offset = (parse(first).getDay() - WEEK_START + 7) % 7;
  const gridStart = addDays(first, -offset);
  const daysInMonth = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
  const weeks = Math.ceil((offset + daysInMonth) / 7);
  const gridEnd = addDays(gridStart, weeks * 7 - 1);

  const { data, error } = useAsync(() => get<{ items: CalItem[] }>(`/api/v1/calendar?from=${gridStart}&to=${gridEnd}`), [gridStart, gridEnd, version]);
  const { data: catalog, reload: reloadCatalog } = useAsync(fetchCatalog, [version]);
  const events = catalog?.find((d) => d.id === 'events');

  const go = (m: string, d = selected) => setParams({ m, d }, { replace: true });
  const pick = (d: string) => setParams({ m: d.slice(0, 7) === month ? month : d.slice(0, 7), d }, { replace: true });
  const toggle = (f: Filter) => setHidden((h) => { const n = new Set(h); if (n.has(f)) n.delete(f); else n.add(f); return n; });
  const saved = () => { setEditing(null); setVersion((v) => v + 1); reloadCatalog(); };

  const open = async (i: CalItem) => {
    if (i.contact) return navigate(`/admin/contacts/${i.contact.id}`);
    if (i.domain !== 'events') return navigate(`/admin/life/${i.domain}`);
    const rec = await run(() => get<Rec>(`/api/v1/data/events/${i.recordId}`));
    if (rec) setEditing(rec);
  };

  if (error) return <ErrorNote error={error} />;
  const items = (data?.items ?? []).filter((i) => !hidden.has(filterOf(i)));
  const on = (day: string) => items.filter((i) => { const [s, e] = daysOf(i); return s <= day && e >= day; });
  const present = new Set((data?.items ?? []).map(filterOf));
  const monthName = parse(first).toLocaleDateString(undefined, { month: 'long' });
  const weekdays = Array.from({ length: 7 }, (_, k) => parse(addDays(gridStart, k)).toLocaleDateString(undefined, { weekday: 'short' }));
  const newDefaults = (day: string) => ({ start: { at: `${day}T09:00`, tz: localZone() }, end: { at: `${day}T10:00`, tz: localZone() } });

  return (
    <div data-screen-label="Calendar" style={{ maxWidth: 1240 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="card-kicker">Calendar</div>
          <h1 style={{ margin: 0 }}>{monthName} <span style={{ color: 'var(--color-neutral-500)' }}>{month.slice(0, 4)}</span></h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 2, padding: 3, borderRadius: 999, border: '1px solid var(--color-divider)' }}>
            <button className="btn btn-ghost" aria-label="Previous month" onClick={() => go(addMonths(month, -1))} style={{ padding: '6px 10px' }}><Chevron dir="left" /></button>
            <button className="btn btn-ghost" onClick={() => go(today.slice(0, 7), today)} style={{ fontSize: 13 }}>Today</button>
            <button className="btn btn-ghost" aria-label="Next month" onClick={() => go(addMonths(month, 1))} style={{ padding: '6px 10px' }}><Chevron dir="right" /></button>
          </div>
          <Pills value={view} options={[['month', 'Month'], ['agenda', 'Agenda']]} onChange={setView} size={13} />
          {events && <button className="btn btn-primary" onClick={() => setEditing('new')}>Add event</button>}
        </div>
      </div>

      {present.size > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '14px 0 18px' }} aria-label="Show on the calendar">
          {FILTERS.filter(([f]) => present.has(f)).map(([f, label]) => (
            <button key={f} className="bare tag" aria-pressed={!hidden.has(f)} onClick={() => toggle(f)}
              style={{ gap: 6, padding: '5px 12px', fontSize: 12, border: '1px solid var(--color-divider)', background: hidden.has(f) ? 'transparent' : 'var(--color-neutral-100)', opacity: hidden.has(f) ? 0.55 : 1 }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: hidden.has(f) ? 'var(--color-neutral-400)' : FILTER_DOT[f] }} />{label}
            </button>
          ))}
        </div>
      )}
      {present.size === 0 && <div style={{ height: 18 }} />}

      {events && events.count === 0 && <Welcome onAdd={() => setEditing('new')} />}

      {!data ? <Loading /> : (
        <div className="cal-layout">
          {view === 'month' ? (
            <div>
              <div className="cal-grid" aria-hidden>{weekdays.map((w) => <div key={w} className="cal-dow">{w}</div>)}</div>
              <div className="cal-grid" role="grid" aria-label={`${monthName} ${month.slice(0, 4)}`}>
                {Array.from({ length: weeks * 7 }, (_, k) => {
                  const day = addDays(gridStart, k);
                  const list = on(day);
                  const weekday = parse(day).getDay();
                  const shown = list.slice(0, 3);
                  return (
                    <button key={day} className="cal-day" aria-pressed={day === selected} onClick={() => pick(day)}
                      data-out={day.slice(0, 7) !== month ? '1' : '0'} data-today={day === today ? '1' : '0'} data-weekend={weekday === 0 || weekday === 6 ? '1' : '0'}
                      aria-label={`${parse(day).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${list.length ? `, ${list.length} item${list.length === 1 ? '' : 's'}` : ''}`}>
                      <span className="cal-num">{+day.slice(8)}</span>
                      {shown.map((i) => <Chip key={i.id} i={i} day={day} col={k % 7} />)}
                      {list.length > 3 && <span className="cal-more">+{list.length - 3} more</span>}
                      <span className="cal-dots" aria-hidden>{list.slice(0, 4).map((i) => <span key={i.id} className="cal-dot" style={{ background: lookOf(i).dot }} />)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <MonthAgenda month={month} days={daysInMonth} on={on} today={today} onOpen={open} onPick={pick} />
          )}
          <DayPanel day={selected} items={on(selected)} today={today} onOpen={open} onAdd={events ? () => setEditing('new') : undefined} />
        </div>
      )}

      {editing && events && (
        <RecordEditor d={events} rec={editing === 'new' ? null : editing} contacts={contacts} onClose={() => setEditing(null)} onSaved={saved}
          defaults={editing === 'new' ? newDefaults(selected) : undefined} />
      )}
    </div>
  );
}

/**
 * One line in a day cell. All-day things are filled bars (joining up across the week when they
 * span days, titled on their first day); timed things are a quiet dot, time and title.
 */
function Chip({ i, day, col }: { i: CalItem; day: string; col: number }) {
  const l = lookOf(i);
  const [s, e] = daysOf(i);
  if (!i.allDay && i.start && s === e) {
    return (
      <span className="cal-chip cal-timed" title={`${timeOf(i.start.at)} ${i.title}`}>
        <span className="cal-dot" style={{ background: l.dot, flex: 'none' }} aria-hidden />
        <b style={{ fontWeight: 600, flex: 'none', color: 'var(--color-neutral-700)' }}>{shortTime(i.start.at)}</b>
        <span>{i.title}</span>
      </span>
    );
  }
  const multi = s !== e;
  const joinLeft = multi && day !== s && col !== 0, joinRight = multi && day !== e && col !== 6;
  const style: CSSProperties = {
    background: l.bg, color: l.ink, border: l.border,
    borderTopLeftRadius: joinLeft ? 0 : 999, borderBottomLeftRadius: joinLeft ? 0 : 999,
    borderTopRightRadius: joinRight ? 0 : 999, borderBottomRightRadius: joinRight ? 0 : 999,
    marginLeft: joinLeft ? -9 : 0, marginRight: joinRight ? -9 : 0,
  };
  const showTitle = !multi || day === s || col === 0;
  return (
    <span className="cal-chip" style={style} title={labelOf(i)}>
      {!i.allDay && i.start && day === s && <b style={{ fontWeight: 600, flex: 'none' }}>{shortTime(i.start.at)}</b>}
      <span>{showTitle ? labelOf(i) : ' '}</span>
    </span>
  );
}

/** The selected day in full: times, places, and where each thing comes from. */
function DayPanel({ day, items, today, onOpen, onAdd }: { day: string; items: CalItem[]; today: string; onOpen: (i: CalItem) => void; onAdd?: () => void }) {
  const d = parse(day);
  const rel = day === today ? 'Today' : day === addDays(today, 1) ? 'Tomorrow' : day === addDays(today, -1) ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long' });
  return (
    <aside className="card" style={{ padding: '22px 22px 18px', gap: 12, position: 'static', top: 12 }} aria-label="Selected day">
      <div>
        <div className="card-kicker">{rel}</div>
        <h3 style={{ margin: '2px 0 0' }}>{d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}</h3>
      </div>
      {items.length ? (
        <div className="cal-day-list">{items.map((i) => <Entry key={i.id} i={i} onOpen={onOpen} />)}</div>
      ) : (
        <p className="text-muted" style={{ fontSize: 14, margin: 0 }}>Nothing on this day.</p>
      )}
      {onAdd && <button className="btn btn-secondary" style={{ alignSelf: 'flex-start', fontSize: 13 }} onClick={onAdd}>Add an event on this day</button>}
    </aside>
  );
}

/** A full row for one item: colour bar, when, what, where it comes from. */
export function Entry({ i, onOpen }: { i: CalItem; onOpen: (i: CalItem) => void }) {
  const l = lookOf(i);
  const [s, e] = daysOf(i);
  const short = (x: string) => parse(x).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const when = !i.allDay && i.start
    ? `${timeOf(i.start.at)}${i.end && i.end.at !== i.start.at ? ` – ${timeOf(i.end.at)}` : ''}${i.start.tz !== localZone() ? ` · ${i.start.tz.split('/').pop()!.replace(/_/g, ' ')} time` : ''}`
    : s !== e ? `${short(s)} – ${short(e)}` : 'All day';
  const from = i.contact ? `Shared by ${i.contact.name}` : i.domain === 'events' ? (i.repeat ? `Repeats ${i.repeat}` : null) : `From ${i.domainLabel}`;
  return (
    <button className="bare cal-entry" onClick={() => onOpen(i)}>
      <span className="cal-bar" style={{ background: i.contact ? 'transparent' : l.dot, borderLeft: i.contact ? l.border : undefined }} aria-hidden />
      <span style={{ flex: 1, minWidth: 0, display: 'grid', gap: 2 }}>
        <span style={{ fontSize: 12, color: 'var(--color-neutral-600)' }}>{when}</span>
        <span style={{ fontWeight: 600, fontSize: 14, lineHeight: 1.3 }}>{i.title}</span>
        {(i.detail || i.location) && <span className="text-muted" style={{ fontSize: 12 }}>{[i.kind === 'expiry' ? `${i.detail} expires` : i.detail, i.location].filter(Boolean).join(' · ')}</span>}
        {from && <span style={{ fontSize: 11, color: l.ink === 'var(--color-neutral-100)' ? 'var(--color-accent-700)' : l.ink }}>{from}</span>}
      </span>
    </button>
  );
}

/** The month as a list: every day with something on it. Easier on a phone. */
function MonthAgenda({ month, days, on, today, onOpen, onPick }: { month: string; days: number; on: (d: string) => CalItem[]; today: string; onOpen: (i: CalItem) => void; onPick: (d: string) => void }) {
  const list = Array.from({ length: days }, (_, k) => `${month}-${pad(k + 1)}`).map((d) => [d, on(d)] as const).filter(([, xs]) => xs.length);
  if (!list.length) return <div className="card" style={{ padding: '26px 24px' }}><div className="card-title">A clear month</div><div className="text-muted" style={{ fontSize: 14 }}>Nothing on the calendar yet.</div></div>;
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {list.map(([d, xs]) => (
        <div key={d} style={{ display: 'grid', gridTemplateColumns: '64px 1fr', gap: 14 }}>
          <button className="bare" onClick={() => onPick(d)} style={{ textAlign: 'center', paddingTop: 6 }}>
            <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--color-neutral-600)' }}>{parse(d).toLocaleDateString(undefined, { weekday: 'short' })}</div>
            <div style={{ fontFamily: 'var(--font-heading)', fontSize: 28, lineHeight: 1.1, ...(d === today ? { color: 'var(--color-accent)' } : {}) }}>{+d.slice(8)}</div>
          </button>
          <div style={{ display: 'grid', gap: 8 }}>{xs.map((i) => <Entry key={i.id} i={i} onOpen={onOpen} />)}</div>
        </div>
      ))}
    </div>
  );
}

/** First visit: what the calendar is, and that it's already full of what you've told your node. */
function Welcome({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="card" style={{ padding: '24px 28px', gap: 8, marginBottom: 20, background: 'var(--color-accent-2-100)', position: 'relative', overflow: 'hidden' }}>
      <div aria-hidden style={{ position: 'absolute', right: -50, top: -70, width: 200, height: 200, borderRadius: '50%', background: 'var(--color-accent-2-200)' }} />
      <div className="card-title" style={{ fontSize: 22, position: 'relative' }}>A calendar that lives with the rest of your life</div>
      <div style={{ fontSize: 14, maxWidth: 640, position: 'relative' }}>
        Birthdays, trips, return-by dates and anything about to expire already appear here, from what you’ve kept in My data. Add your own events and they stay on your Little Dipper. Share them with a contact only if you choose to.
      </div>
      <button className="btn btn-primary" style={{ alignSelf: 'flex-start', marginTop: 6, position: 'relative' }} onClick={onAdd}>Add your first event</button>
    </div>
  );
}

const Chevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ transform: dir === 'right' ? 'scaleX(-1)' : undefined }}>
    <path d="M14.5 6 8.5 12l6 6" />
  </svg>
);
