/**
 * Open-now / next-open judgment over an account's business_hours (the
 * {"mon": [["09:00","17:00"]], ...} shape the NutriBiotic OS's geocoder
 * writes). Ported from portfolio/src/app/nutribiotic/lib/hours.ts, plus a
 * same-day "next open window" push used by the route schedule below: a
 * missing hours record is never treated as open, and a stop that cannot be
 * reached inside its own hours is named, never silently scheduled anyway.
 *
 * Pure, no I/O, framework free.
 */
import { WEEKDAY_KEYS, dayKeyOf } from "./field-week";

export type BusinessHours = Record<string, string[][]>;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** "18:00" -> "6PM", "17:30" -> "5:30PM". */
export function fmtHour(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${period}` : `${h12}${period}`;
}

/** The open windows (start/end minutes) for a stop on the given
 *  planning-horizon date, or null when nothing is on file to judge by. */
export function windowsFor(businessHours: BusinessHours | null | undefined, dayIso: string): [number, number][] | null {
  if (!businessHours || Object.keys(businessHours).length === 0) return null;
  const key = dayKeyOf(dayIso);
  const ranges = businessHours[key];
  if (ranges === undefined) return null;
  return ranges.map(([s, e]) => [toMinutes(s), toMinutes(e)]);
}

export type HourPush =
  | { state: "open" } // arrival already falls in an open window
  | { state: "pushed"; to: number } // arrival pushed forward to the next window that day
  | { state: "closed_today" }; // hours are known and there is no later window that day

/**
 * HARD CONSTRAINT: never assumes open on missing data (returns "open" with
 * nothing to push against, i.e. unconstrained), and never lets a stop land
 * inside a closed window silently. Only ever pushes the clock FORWARD,
 * within the same calendar day the route is being built for.
 */
export function pushToOpenWindow(
  businessHours: BusinessHours | null | undefined,
  dayIso: string,
  arriveMinutes: number,
): HourPush {
  const windows = windowsFor(businessHours, dayIso);
  if (windows === null) return { state: "open" }; // nothing on file: not constrained
  if (windows.length === 0) return { state: "closed_today" }; // hours on file, closed all day

  for (const [start, end] of windows) {
    if (arriveMinutes >= start && arriveMinutes < end) return { state: "open" };
  }
  const next = windows.find(([start]) => start >= arriveMinutes);
  if (next) return { state: "pushed", to: next[0] };
  return { state: "closed_today" }; // every window today has already passed
}

/** "mon".."sun" for today in Los Angeles. */
export function laTodayKey(): (typeof WEEKDAY_KEYS)[number] {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).formatToParts(new Date());
  const w = (parts.find((p) => p.type === "weekday")?.value ?? "").toLowerCase().slice(0, 3);
  return (WEEKDAY_KEYS as readonly string[]).includes(w) ? (w as (typeof WEEKDAY_KEYS)[number]) : "sun";
}

export type HoursStatus = { open: boolean; label: string };

/** "Open · closes 6PM" / "Closed · opens 9AM" today / null when nothing is
 *  on file. Used for the badge next to a stop, judged against right now. */
export function hoursStatusNow(businessHours: BusinessHours | null | undefined): HoursStatus | null {
  if (!businessHours || Object.keys(businessHours).length === 0) return null;
  const todayKey = laTodayKey();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const minutes =
    Number(parts.find((p) => p.type === "hour")?.value ?? "0") * 60 +
    Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  const today = businessHours[todayKey] || [];
  for (const [start, end] of today) {
    if (minutes >= toMinutes(start) && minutes < toMinutes(end)) {
      return { open: true, label: `Open, closes ${fmtHour(end)}` };
    }
  }
  const idx = WEEKDAY_KEYS.indexOf(todayKey);
  for (let offset = 0; offset < 7; offset++) {
    const key = WEEKDAY_KEYS[(idx + offset) % 7];
    const ranges = businessHours[key] || [];
    for (const [start] of ranges) {
      if (offset === 0 && toMinutes(start) <= minutes) continue;
      const when = offset === 0 ? fmtHour(start) : `${key[0].toUpperCase()}${key.slice(1)} ${fmtHour(start)}`;
      return { open: false, label: `Closed, opens ${when}` };
    }
  }
  return { open: false, label: "Closed" };
}
