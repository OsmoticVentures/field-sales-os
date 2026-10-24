/**
 * Google Calendar on the route. The Mac writes the next 14 days of Juan's
 * calendar to nb_ui_prefs.route_calendar (bridges/nutribiotic/
 * calendar_to_route.py); this turns one day of it into what the route does:
 *
 *  - an event with a place, starting inside the working day, is a stop: a
 *    custom stop with a fixed arrival (its start, kept in route_stop_times
 *    like any stated time) that stays as long as the event runs;
 *  - an event with a time but no place holds its time, so no stop is put
 *    inside it. Two hours or less holds by default; a longer one reads as a
 *    planning block and is listed only. Juan flips either on the day;
 *  - everything else (all-day, evening, taken off the route) is listed.
 *
 * Framework-free and pure, so the screen and a test share one reading. The
 * calendar stays the source: the route's copy of an event follows it when
 * the event moves, and leaves when the event is deleted.
 */

import {
  CALENDAR_DAY_FROM,
  CALENDAR_DAY_UNTIL,
  CALENDAR_HOLD_MAX_MINUTES,
  calendarBaseKey,
  calendarChoiceKey,
  calendarStopId,
  type CalendarEvent,
  type CustomStop,
  type RouteDraftEntry,
} from "./types";
import { haversineMiles } from "./route-optimize";

export const hhmmMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};

export type CalendarHold = { id: string; title: string; start: number; end: number };

export type CalendarListed = {
  event: CalendarEvent;
  /** What a tap does on this row, if anything. */
  action: "hold" | "free" | "add" | null;
  held: boolean;
};

export type CalendarDay = {
  stops: CustomStop[];
  holds: CalendarHold[];
  listed: CalendarListed[];
};

const located = (e: CalendarEvent): e is CalendarEvent & { lat: number; lng: number; start: string; end: string } =>
  !e.allDay && typeof e.lat === "number" && typeof e.lng === "number" && !!e.start && !!e.end;

const inWorkday = (e: CalendarEvent) =>
  !e.allDay && !!e.start && hhmmMinutes(e.start) >= CALENDAR_DAY_FROM && hhmmMinutes(e.start) < CALENDAR_DAY_UNTIL;

const lengthOf = (e: CalendarEvent) => (e.start && e.end ? Math.max(0, hhmmMinutes(e.end) - hhmmMinutes(e.start)) : 0);

export function calendarDay(events: CalendarEvent[], times: Record<string, string>): CalendarDay {
  const stops: CustomStop[] = [];
  const holds: CalendarHold[] = [];
  const listed: CalendarListed[] = [];
  for (const e of events) {
    const choice = times[calendarChoiceKey(e.id)];
    if (located(e) && inWorkday(e)) {
      if (choice === "off") {
        listed.push({ event: e, action: "add", held: false });
        continue;
      }
      stops.push({
        id: calendarStopId(e.id),
        kind: "event",
        label: e.title,
        address: e.address ?? e.location ?? "",
        lat: e.lat,
        lng: e.lng,
        calendarId: e.id,
        minutes: lengthOf(e),
      });
      continue;
    }
    if (!e.allDay && e.start && e.end && inWorkday(e)) {
      const held = choice === "hold" || (choice !== "free" && lengthOf(e) <= CALENDAR_HOLD_MAX_MINUTES);
      if (held) holds.push({ id: e.id, title: e.title, start: hhmmMinutes(e.start), end: hhmmMinutes(e.end) });
      listed.push({ event: e, action: held ? "free" : "hold", held });
      continue;
    }
    listed.push({ event: e, action: null, held: false });
  }
  holds.sort((a, b) => a.start - b.start);
  return { stops, holds, listed };
}

/** Rough arrival clock for each position, straight-line at a SoCal average
 *  plus each stop's stay. Only ever used to decide WHERE a timed event goes
 *  in the order, never shown as a time. */
const ROUGH_MPH = 24;

type Pt = { lat: number; lng: number };

export function placeByTime(
  order: RouteDraftEntry[],
  timed: { entry: RouteDraftEntry; at: number }[],
  pointOf: (e: RouteDraftEntry) => Pt | null,
  start: Pt | null,
  departMinutes: number,
  dwellMinutes: number,
  /** A stop's stated time, when it has one: the clock waits for it, and a
   *  later event never goes in ahead of it. */
  timeOf: (e: RouteDraftEntry) => number | null = () => null,
): RouteDraftEntry[] {
  const out = [...order];
  const placedAt = new Map<RouteDraftEntry, number>();
  for (const { entry, at } of [...timed].sort((a, b) => a.at - b.at)) {
    let t = departMinutes;
    let pos: Pt | null = start;
    let insertAt = out.length;
    for (let i = 0; i < out.length; i++) {
      const p = pointOf(out[i]);
      if (!p) continue;
      if (pos) t += (haversineMiles(pos, p) / ROUGH_MPH) * 60;
      const fixed = placedAt.get(out[i]) ?? timeOf(out[i]);
      if (fixed !== null) t = Math.max(t, fixed);
      if (fixed !== null ? fixed > at : t >= at) {
        insertAt = i;
        break;
      }
      const e = out[i];
      t += typeof e !== "string" && typeof e.minutes === "number" ? e.minutes : dwellMinutes;
      pos = p;
    }
    out.splice(insertAt, 0, entry);
    placedAt.set(entry, at);
  }
  return out;
}

/** The day's draft and stop times once the calendar is applied: event stops
 *  added at their time, moved ones updated in place, deleted ones gone. Null
 *  when nothing changes, so a reconcile never writes for nothing. */
export function reconcileCalendar(
  draft: RouteDraftEntry[],
  times: Record<string, string>,
  day: CalendarDay,
  events: CalendarEvent[],
  place: (order: RouteDraftEntry[], timed: { entry: CustomStop; at: number }[]) => RouteDraftEntry[],
): { draft: RouteDraftEntry[]; times: Record<string, string> } | null {
  const want = new Map(day.stops.map((s) => [s.id, s]));
  const startOf = new Map(events.map((e) => [calendarStopId(e.id), e.start]));
  let changed = false;

  const kept: RouteDraftEntry[] = [];
  for (const e of draft) {
    if (typeof e === "string" || !e.calendarId) {
      kept.push(e);
      continue;
    }
    const w = want.get(e.id);
    // Gone from the calendar, or moved to another time: out, and a moved
    // one goes back in where its new time falls. A time the rep set on the
    // route stands while the calendar still says what it said then.
    const base = times[calendarBaseKey(e.calendarId)] ?? times[e.id];
    if (!w || (base && base !== startOf.get(e.id))) {
      changed = true;
      continue;
    }
    if (w.label !== e.label || w.address !== e.address || w.lat !== e.lat || w.lng !== e.lng || w.minutes !== e.minutes) {
      changed = true;
      kept.push({ ...e, ...w });
    } else kept.push(e);
  }

  const have = new Set(kept.map((e) => (typeof e === "string" ? e : e.id)));
  const missing = day.stops.filter((s) => !have.has(s.id));
  const nextDraft = missing.length
    ? place(kept, missing.map((s) => ({ entry: s, at: hhmmMinutes(startOf.get(s.id) ?? "00:00") })))
    : kept;
  if (missing.length) changed = true;

  const nextTimes = { ...times };
  for (const id of Object.keys(nextTimes)) {
    const gone =
      (id.startsWith("custom:cal:") && !want.has(id)) ||
      (id.startsWith("calbase:") && !want.has(`custom:cal:${id.slice("calbase:".length)}`));
    if (gone) {
      delete nextTimes[id];
      changed = true;
    }
  }
  for (const s of day.stops) {
    const at = startOf.get(s.id);
    const baseKey = calendarBaseKey(s.calendarId!);
    if (baseKey in nextTimes) {
      if (nextTimes[baseKey] === at) continue;
      delete nextTimes[baseKey];
      changed = true;
    }
    if (at && nextTimes[s.id] !== at) {
      nextTimes[s.id] = at;
      changed = true;
    }
  }
  return changed ? { draft: nextDraft, times: nextTimes } : null;
}
