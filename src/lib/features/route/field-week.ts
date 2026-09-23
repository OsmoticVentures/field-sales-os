/**
 * The planning horizon: today's field days rolling ten days deep, every day
 * of the week. Ported unchanged from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/field-week.ts). Pure, no I/O, framework
 * free so it works from both the server and the client.
 */

const WEEKDAY: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export const PLANNING_HORIZON_DAYS = 10;

function laToday(): { iso: string; weekdayIso: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { iso: `${get("year")}-${get("month")}-${get("day")}`, weekdayIso: WEEKDAY[get("weekday")] ?? 1 };
}

/** Today in Los Angeles as "YYYY-MM-DD". */
export function laTodayIso(): string {
  return laToday().iso;
}

function weekdayIsoOf(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay(); // 0=Sun..6=Sat
  return dow === 0 ? 7 : dow;
}

/** The next `count` days starting today, every day of the week included. */
export function planningHorizonDates(count: number = PLANNING_HORIZON_DAYS): string[] {
  const { iso } = laToday();
  const [y, m, d] = iso.split("-").map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  const out: string[] = [];
  while (out.length < count) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export function nextWeekday(weekdayIso: number): string {
  return planningHorizonDates(7).find((d) => weekdayIsoOf(d) === weekdayIso) ?? planningHorizonDates(1)[0];
}

/** Today if it's on the horizon, else the first day on it with stops in it,
    else the first day. */
export function defaultActiveDay(byDay: Record<string, unknown[] | undefined>, days: string[]): string {
  const { iso } = laToday();
  if (days.includes(iso)) return iso;
  return days.find((d) => (byDay[d]?.length ?? 0) > 0) ?? days[0];
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** "2026-08-25" -> { weekday: "Tue", short: "8/25" }. */
export function dayLabel(iso: string): { weekday: string; short: string } {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return { weekday: WEEKDAY_NAMES[dt.getUTCDay()], short: `${m}/${d}` };
}

/** "mon".."sun" for the weekday a given planning-horizon date falls on. */
export function dayKeyOf(iso: string): (typeof WEEKDAY_KEYS)[number] {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return WEEKDAY_KEYS[dow];
}
