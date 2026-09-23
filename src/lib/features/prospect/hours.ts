/**
 * Open-now / next-open judgment over nb_accounts.business_hours, the
 * {"mon": [["09:00","17:00"]], ...} shape the Mac-side headhunter and Places
 * enrichment both write. Pure, no I/O, not tagged server-only: the schedule
 * list and the account panel both need this from a client component.
 *
 * Ported unchanged from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/hours.ts). Los Angeles wall-clock
 * throughout: the whole territory is one zone and it is not UTC.
 */

export type BusinessHours = Record<string, string[][]>;

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type DayKey = (typeof DAY_KEYS)[number];
const DAY_LABEL: Record<DayKey, string> = {
  sun: "Sun",
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
};

function laNow(): { dayIndex: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const dayIndex = DAY_KEYS.indexOf(get("weekday").toLowerCase().slice(0, 3) as DayKey);
  return { dayIndex: dayIndex < 0 ? 0 : dayIndex, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

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

export type HoursStatus = { open: boolean; label: string };

/**
 * "Open, closes 6PM" / "Closed, opens 9AM" (later today) / "Closed, opens
 * Tue 9AM" (a later day) / "Closed" (hours on file but never open, rare) /
 * null when there is nothing on file to judge by. A null return renders no
 * badge, never a guessed one.
 */
export function hoursStatus(businessHours: BusinessHours | null | undefined): HoursStatus | null {
  if (!businessHours || Object.keys(businessHours).length === 0) return null;
  const { dayIndex, minutes } = laNow();

  const today = businessHours[DAY_KEYS[dayIndex]] || [];
  for (const [start, end] of today) {
    if (minutes >= toMinutes(start) && minutes < toMinutes(end)) {
      return { open: true, label: `Open, closes ${fmtHour(end)}` };
    }
  }

  for (let offset = 0; offset < 7; offset++) {
    const idx = (dayIndex + offset) % 7;
    const ranges = businessHours[DAY_KEYS[idx]] || [];
    for (const [start] of ranges) {
      if (offset === 0 && toMinutes(start) <= minutes) continue; // already passed today
      const when = offset === 0 ? fmtHour(start) : `${DAY_LABEL[DAY_KEYS[idx]]} ${fmtHour(start)}`;
      return { open: false, label: `Closed, opens ${when}` };
    }
  }
  return { open: false, label: "Closed" };
}

/** "mon".."sun" for today in Los Angeles, so a weekly hours table can bold
 *  the row that actually matters right now instead of reading as seven
 *  equally-weighted lines. */
export function laTodayKey(): string {
  return DAY_KEYS[laNow().dayIndex];
}
