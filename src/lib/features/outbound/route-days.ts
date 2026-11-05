/**
 * The days Juan is already driving near an account, read off his own route.
 *
 * WHY. "Propose a specific date" is the correction he has made most often (16
 * rewritten drafts by 2026-11-03), and the composer could not obey it: the only
 * facts it held were the note's, and a note rarely names a day. His route does.
 * A day from it is a fact he planned, so an email may propose it. Pure, so
 * tests/route-days.test.mts runs it under plain node.
 */

export type RouteDay = { date: string; label: string; onRoute: boolean };
export type Place = { id: string; city: string | null; lat: number | null; lng: number | null };

/** Straight-line miles a stop can be from the account and still be "in the area". */
const NEAR_MILES = 15;
/** A day sooner than this gives them no time to answer. */
const MIN_LEAD_DAYS = 2;
const MAX_LEAD_DAYS = 45;
const MAX_DAYS = 2;

function miles(a: Place, b: Place): number | null {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 3959 * 2 * Math.asin(Math.sqrt(h));
}

function near(a: Place, b: Place): boolean {
  const d = miles(a, b);
  if (d !== null) return d <= NEAR_MILES;
  return Boolean(a.city && b.city && a.city.trim().toLowerCase() === b.city.trim().toLowerCase());
}

export function dayLabel(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const weekday = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const month = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${weekday}, ${month} ${d.getUTCDate()}`;
}

/** Days already planned near the account, the ones with the account itself on them first. */
export function daysNear(
  routeDraft: Record<string, unknown[]>,
  places: Map<string, Place>,
  target: Place,
  today: string,
): RouteDay[] {
  const start = Date.parse(`${today}T12:00:00Z`);
  const out: RouteDay[] = [];
  for (const date of Object.keys(routeDraft).sort()) {
    const lead = (Date.parse(`${date}T12:00:00Z`) - start) / 864e5;
    if (lead < MIN_LEAD_DAYS || lead > MAX_LEAD_DAYS) continue;
    const ids = (routeDraft[date] ?? []).filter((e): e is string => typeof e === "string");
    const onRoute = ids.includes(target.id);
    if (onRoute || ids.some((id) => { const p = places.get(id); return p ? near(target, p) : false; })) {
      out.push({ date, label: dayLabel(date), onRoute });
    }
  }
  return [...out.filter((d) => d.onRoute), ...out.filter((d) => !d.onRoute)].slice(0, MAX_DAYS);
}
