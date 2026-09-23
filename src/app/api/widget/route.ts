/**
 * The route, as one JSON snapshot a home-screen widget can render. Ported
 * from the NutriBiotic OS (portfolio/src/app/nutribiotic/api/widget/route.ts).
 * A mirror of the route screen's own draft, never a second source: nothing
 * here recomputes, reorders or optimizes anything.
 *
 * The public origin comes from NB_PUBLIC_ORIGIN, never a hard-coded domain,
 * per the port brief.
 */
import {
  getHomeEndpoint,
  getLastLocation,
  getRouteMileageByDay,
  getRouteSchedulePrefs,
  getRouteStateByDay,
  isConfigured,
  listOwnerAccounts,
} from "../../../lib/features/route/dal";
import { defaultActiveDay, planningHorizonDates } from "../../../lib/features/route/field-week";
import { likelyDriveMinutes } from "../../../lib/features/route/traffic";
import type { CustomStopKind, RouteAccount, Tier } from "../../../lib/features/route/types";
import { hasAccess } from "../../../lib/core/devices";
import { hasWidgetToken } from "../../../lib/features/route/widget-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function origin(): string {
  return process.env.NB_PUBLIC_ORIGIN ?? "";
}

function nowMinutesLA(): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function appleMapsUrl(p: { address?: string | null; lat: number; lng: number }): string {
  const daddr = p.address ? encodeURIComponent(p.address) : `${p.lat},${p.lng}`;
  return `https://maps.apple.com/?daddr=${daddr}`;
}

type Stop = {
  n: number;
  id: string;
  type: "account" | "custom";
  kind: CustomStopKind | null;
  name: string;
  address: string | null;
  city: string | null;
  lat: number;
  lng: number;
  tier: Tier | null;
  phone: string | null;
  website: string | null;
  hubspot_url: string | null;
  last_order_at: string | null;
  trailing_12m_revenue: number | null;
  lifetime_revenue: number | null;
  straight_line_miles_from_prev: number | null;
  done: boolean;
  maps_url: string;
  call_url: string | null;
  account_url: string | null;
};

export async function GET(request: Request) {
  if (!(await hasWidgetToken(request)) && !(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  if (!isConfigured()) {
    return Response.json({ ok: false, error: "No data source configured." }, { status: 500 });
  }

  const [state, accounts, prefs, mileageByDay, lastLocation, home] = await Promise.all([
    getRouteStateByDay(),
    listOwnerAccounts(),
    getRouteSchedulePrefs(),
    getRouteMileageByDay(),
    getLastLocation(),
    getHomeEndpoint(),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const days = planningHorizonDates();
  const requested = new URL(request.url).searchParams.get("day");
  const day = requested && days.includes(requested) ? requested : defaultActiveDay(state.draft, days);
  const draft = state.draft[day] ?? [];
  const doneIds = new Set(state.done[day] ?? []);

  const calls = (state.calls[day] ?? []).map((c) => ({
    id: c.id,
    name: c.label,
    phone: c.phone,
    note: c.note ?? null,
    call_url: `tel:${c.phone.replace(/[^\d+]/g, "")}`,
    account_url: c.accountId ? `${origin()}/nb/route?focus=${c.accountId}` : null,
  }));

  const stops: Stop[] = [];
  for (const e of draft) {
    if (typeof e !== "string") {
      stops.push({
        n: stops.length + 1,
        id: e.id,
        type: "custom",
        kind: e.kind,
        name: e.label,
        address: e.address,
        city: null,
        lat: e.lat,
        lng: e.lng,
        tier: null,
        phone: null,
        website: null,
        hubspot_url: null,
        last_order_at: null,
        trailing_12m_revenue: null,
        lifetime_revenue: null,
        straight_line_miles_from_prev: null,
        done: doneIds.has(e.id),
        maps_url: appleMapsUrl(e),
        call_url: null,
        account_url: null,
      });
      continue;
    }
    const a: RouteAccount | undefined = byId.get(e);
    if (!a) continue;
    stops.push({
      n: stops.length + 1,
      id: a.id,
      type: "account",
      kind: null,
      name: a.name,
      address: a.street,
      city: a.city,
      lat: a.lat,
      lng: a.lng,
      tier: a.tier,
      phone: a.phone,
      website: a.website,
      hubspot_url: a.hubspot_company_id ? `https://app.hubspot.com/contacts/company/${a.hubspot_company_id}` : null,
      last_order_at: a.last_order_at,
      trailing_12m_revenue: a.trailing_12m_revenue,
      lifetime_revenue: a.lifetime_revenue,
      straight_line_miles_from_prev: null,
      done: doneIds.has(a.id),
      maps_url: appleMapsUrl({ address: [a.street, a.city, a.state].filter(Boolean).join(", "), lat: a.lat, lng: a.lng }),
      call_url: a.phone ? `tel:${a.phone.replace(/[^\d+]/g, "")}` : null,
      account_url: `${origin()}/nb/route?focus=${a.id}`,
    });
  }

  let total = 0;
  for (let i = 1; i < stops.length; i++) {
    const miles = haversineMiles(stops[i - 1], stops[i]);
    stops[i].straight_line_miles_from_prev = Number(miles.toFixed(1));
    total += miles;
  }

  /* A rough, live finish-time estimate: no Directions call here (see the
     file header), so free-flow per leg is this endpoint's own circuity/speed
     guess; the time-of-day multiplier over it is traffic.ts's real curve,
     the same one the route screen prices every leg with, so the two never
     quote a different "back by" for the same day. */
  const dayMileage = mileageByDay[day] ?? {};
  let schedule: { depart: string; finish_clock: string; over: boolean; return_by: string | null; live: boolean; rough: true } | null = null;
  if (home && stops.length > 0) {
    const CIRCUITY = 1.28;
    const FREEWAY_MPH = 42;
    const SURFACE_MPH = 21;
    const FREEWAY_MIN_MILES = 6;
    const [dy, dm2, dd] = day.split("-").map(Number);
    const dateAtMinutes = (mins: number): Date => {
      const wrapped = ((Math.round(mins) % 1440) + 1440) % 1440;
      return new Date(Date.UTC(dy, dm2 - 1, dd, Math.floor(wrapped / 60), wrapped % 60));
    };
    const leg = (a: { lat: number; lng: number }, b: { lat: number; lng: number }, departAtMinutes: number) => {
      const miles = haversineMiles(a, b) * CIRCUITY;
      const mph = miles >= FREEWAY_MIN_MILES ? FREEWAY_MPH : SURFACE_MPH;
      const freeFlow = (miles / mph) * 60;
      return Math.max(4, likelyDriveMinutes(freeFlow, dateAtMinutes(departAtMinutes)));
    };
    const [dh, dm] = prefs.depart.split(":").map(Number);
    const departMin = (Number.isFinite(dh) ? dh : 9) * 60 + (Number.isFinite(dm) ? dm : 30);
    const nowMin = nowMinutesLA();

    let lastDoneIdx = -1;
    stops.forEach((s, i) => {
      if (s.done) lastDoneIdx = i;
    });
    const remaining = stops.filter((s) => !s.done);

    const LOCATION_FRESH_MINUTES = 90;
    const freshLocation =
      lastLocation && Date.now() - new Date(lastLocation.at).getTime() < LOCATION_FRESH_MINUTES * 60_000 ? lastLocation : null;

    const startPos = freshLocation
      ? { lat: freshLocation.lat, lng: freshLocation.lng }
      : lastDoneIdx >= 0
        ? { lat: stops[lastDoneIdx].lat, lng: stops[lastDoneIdx].lng }
        : { lat: home.lat, lng: home.lng };
    const dayStarted = Boolean(freshLocation) || lastDoneIdx >= 0 || Boolean(dayMileage.start);

    let t = dayStarted ? nowMin : Math.max(departMin, nowMin);
    let pos = startPos;
    for (const s of remaining) {
      t += leg(pos, s, t);
      const dwell = s.kind === "lunch" ? prefs.lunchMinutes : s.kind === "hotel" ? 0 : prefs.dwellMinutes;
      t += dwell;
      pos = s;
    }
    t += leg(pos, home, t);
    const clock = (mins: number) => {
      const wrapped = ((Math.round(mins) % 1440) + 1440) % 1440;
      return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
    };
    const returnByMin = prefs.returnBy
      ? (() => {
          const [rh, rm] = prefs.returnBy!.split(":").map(Number);
          return rh * 60 + rm;
        })()
      : null;
    schedule = {
      depart: prefs.depart,
      finish_clock: clock(t),
      over: returnByMin !== null && t > returnByMin,
      return_by: prefs.returnBy,
      live: dayStarted,
      rough: true,
    };
  }

  const accountStops = stops.filter((s) => s.type === "account");
  const allAccountStopsDone = accountStops.length > 0 && accountStops.every((s) => s.done);
  const day_state: "not_started" | "in_progress" | "ready_to_end" | "ended" = !dayMileage.start
    ? "not_started"
    : dayMileage.end
      ? "ended"
      : allAccountStopsDone
        ? "ready_to_end"
        : "in_progress";

  return Response.json(
    {
      ok: true,
      generated_at: new Date().toISOString(),
      day,
      days,
      count: stops.length,
      stops,
      calls,
      schedule,
      day_state,
      mileage_error: dayMileage.fileError ?? null,
      total_straight_line_miles: stops.length > 1 ? Number(total.toFixed(1)) : null,
      maps_all_url: stops.length > 1 ? `https://maps.apple.com/?daddr=${stops.map((s) => `${s.lat},${s.lng}`).join("+to:")}` : null,
      route_url: `${origin()}/nb/route`,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
