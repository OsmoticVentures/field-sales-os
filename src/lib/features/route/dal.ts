/**
 * Route feature data access: reads Juan's owned book and reads/writes the
 * route draft, calls, done marks, stop times, endpoints, schedule prefs,
 * last location, last odometer and mileage-by-day. Same Supabase project
 * and the SAME real tables/columns the NutriBiotic OS's lib/dal.ts already
 * writes (nb_accounts, nb_ui_prefs id=1, nb_v_account_potential), confirmed
 * by grep against portfolio/src/app/nutribiotic/lib/dal.ts, not guessed: a
 * route built in the old app during the parallel-run window shows up here
 * too, and vice versa.
 *
 * No shared data layer exists yet in this repo (m5/PORTING.md), so this
 * module talks to Supabase directly, same pattern as lib/core/devices.ts.
 */
import "server-only";
import type {
  CallEntry,
  CustomStop,
  CustomStopKind,
  RouteAccount,
  RouteDraftEntry,
  RouteEndpoint,
  RouteSchedulePrefs,
  Tier,
} from "./types";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
export const isConfigured = (): boolean => Boolean(SB_URL && SB_KEY);

export const JUAN_OWNER_ID = "36242368";

async function sb(table: string, query: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SB_URL}/rest/v1/${table}?${query}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
}

async function raw<T>(table: string, query: string): Promise<T[]> {
  if (!isConfigured()) return [];
  const res = await sb(table, query);
  if (!res.ok) throw new Error(`Supabase ${table} -> HTTP ${res.status}`);
  return (await res.json()) as T[];
}

async function prefsPatch(patch: Record<string, unknown>): Promise<void> {
  if (!isConfigured()) throw new Error("No data source configured.");
  const res = await sb("nb_ui_prefs", "id=eq.1", {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`Supabase nb_ui_prefs PATCH -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function prefsSelect<T extends Record<string, unknown>>(select: string): Promise<T | null> {
  const rows = await raw<T>("nb_ui_prefs", `select=${select}&id=eq.1`);
  return rows[0] ?? null;
}

// --- Accounts ---------------------------------------------------------

type AccountRow = Omit<RouteAccount, "tier">;

export async function listOwnerAccounts(): Promise<RouteAccount[]> {
  const [rows, grades] = await Promise.all([
    raw<AccountRow>(
      "nb_accounts",
      "select=id,name,street,city,state,lat,lng,phone,website,hubspot_company_id,lead_stage,lifecycle,last_order_at,trailing_12m_revenue,lifetime_revenue,business_hours" +
        `&hubspot_owner_id=eq.${JUAN_OWNER_ID}&lat=not.is.null&closed_at=is.null&order=name.asc`,
    ),
    raw<{ account_id: string; potential_grade: Tier }>(
      "nb_v_account_potential",
      "select=account_id,potential_grade&limit=1000",
    ),
  ]);
  const tierById = new Map(grades.map((g) => [g.account_id, g.potential_grade]));
  return rows.map((a) => ({ ...a, tier: tierById.get(a.id) ?? null }));
}

export async function getHomeEndpoint(): Promise<RouteEndpoint | null> {
  const rows = await raw<{ name: string; street: string | null; city: string | null; state: string | null; postal: string | null; lat: number; lng: number }>(
    "nb_accounts",
    "select=name,street,city,state,postal,lat,lng&lifecycle=eq.waypoint&limit=1",
  );
  const w = rows[0];
  if (!w) return null;
  const address = [w.street, w.city, w.state, w.postal].filter(Boolean).join(", ") || w.name;
  return { label: "Home", address, lat: w.lat, lng: w.lng };
}

// --- Schedule prefs -----------------------------------------------------

const DEFAULT_PREFS: RouteSchedulePrefs = { depart: "09:30", dwellMinutes: 20, lunchMinutes: 30, returnBy: null };

function hhmm(t: string | null): string | null {
  if (!t) return null;
  const m = /^(\d{2}):(\d{2})/.exec(t);
  return m ? `${m[1]}:${m[2]}` : null;
}

export async function getRouteSchedulePrefs(): Promise<RouteSchedulePrefs> {
  const row = await prefsSelect<{
    route_depart: string | null;
    route_dwell_minutes: number | null;
    route_lunch_minutes: number | null;
    route_return_by: string | null;
  }>("route_depart,route_dwell_minutes,route_lunch_minutes,route_return_by");
  if (!row) return DEFAULT_PREFS;
  return {
    depart: hhmm(row.route_depart) ?? DEFAULT_PREFS.depart,
    dwellMinutes: row.route_dwell_minutes ?? DEFAULT_PREFS.dwellMinutes,
    lunchMinutes: row.route_lunch_minutes ?? DEFAULT_PREFS.lunchMinutes,
    returnBy: hhmm(row.route_return_by),
  };
}

export async function saveRouteSchedulePrefs(p: RouteSchedulePrefs): Promise<void> {
  await prefsPatch({
    route_depart: p.depart,
    route_dwell_minutes: p.dwellMinutes,
    route_lunch_minutes: p.lunchMinutes,
    route_return_by: p.returnBy,
  });
}

// --- Route draft, calls, done, stop times -------------------------------

const CUSTOM_KINDS: CustomStopKind[] = ["lunch", "hotel", "stop"];

function asDraftEntry(x: unknown): RouteDraftEntry | null {
  if (typeof x === "string") return x;
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.startsWith("custom:")) return null;
  if (typeof o.kind !== "string" || !CUSTOM_KINDS.includes(o.kind as CustomStopKind)) return null;
  if (typeof o.label !== "string" || typeof o.address !== "string") return null;
  if (typeof o.lat !== "number" || typeof o.lng !== "number") return null;
  if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) return null;
  return { id: o.id, kind: o.kind as CustomStopKind, label: o.label, address: o.address, lat: o.lat, lng: o.lng };
}

function asDraftByDay(stored: unknown): Record<string, RouteDraftEntry[]> {
  if (!stored || typeof stored !== "object") return {};
  const out: Record<string, RouteDraftEntry[]> = {};
  for (const [day, entries] of Object.entries(stored as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    out[day] = entries.map(asDraftEntry).filter((e): e is RouteDraftEntry => e !== null);
  }
  return out;
}

function asCallsByDay(stored: unknown): Record<string, CallEntry[]> {
  if (!stored || typeof stored !== "object") return {};
  const out: Record<string, CallEntry[]> = {};
  for (const [day, entries] of Object.entries(stored as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    out[day] = entries.filter(
      (e): e is CallEntry => e && typeof e === "object" && typeof e.id === "string" && typeof e.label === "string" && typeof e.phone === "string",
    );
  }
  return out;
}

function asDoneByDay(stored: unknown): Record<string, string[]> {
  if (!stored || typeof stored !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [day, ids] of Object.entries(stored as Record<string, unknown>)) {
    if (Array.isArray(ids)) out[day] = ids.filter((x): x is string => typeof x === "string");
  }
  return out;
}

function asTimesByDay(stored: unknown): Record<string, Record<string, string>> {
  if (!stored || typeof stored !== "object") return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [day, times] of Object.entries(stored as Record<string, unknown>)) {
    if (times && typeof times === "object") out[day] = times as Record<string, string>;
  }
  return out;
}

export type RouteState = {
  draft: Record<string, RouteDraftEntry[]>;
  calls: Record<string, CallEntry[]>;
  done: Record<string, string[]>;
  times: Record<string, Record<string, string>>;
};

export async function getRouteStateByDay(): Promise<RouteState> {
  const row = await prefsSelect<{ route_draft: unknown; route_calls: unknown; route_done: unknown; route_stop_times: unknown }>(
    "route_draft,route_calls,route_done,route_stop_times",
  );
  if (!row) return { draft: {}, calls: {}, done: {}, times: {} };
  return {
    draft: asDraftByDay(row.route_draft),
    calls: asCallsByDay(row.route_calls),
    done: asDoneByDay(row.route_done),
    times: asTimesByDay(row.route_stop_times),
  };
}

export async function setRouteDraft(byDay: Record<string, RouteDraftEntry[]>): Promise<void> {
  await prefsPatch({ route_draft: byDay });
}

export async function setRouteCalls(byDay: Record<string, CallEntry[]>): Promise<void> {
  await prefsPatch({ route_calls: byDay });
}

export async function setRouteDone(byDay: Record<string, string[]>): Promise<void> {
  await prefsPatch({ route_done: byDay });
}

export async function setRouteStopTimes(byDay: Record<string, Record<string, string>>): Promise<void> {
  await prefsPatch({ route_stop_times: byDay });
}

// --- Start/end endpoints, by day ---------------------------------------

function sanitizeRouteEndpoint(x: unknown): RouteEndpoint | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.label !== "string" || typeof o.address !== "string") return null;
  if (typeof o.lat !== "number" || typeof o.lng !== "number") return null;
  if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng)) return null;
  return { label: o.label, address: o.address, lat: o.lat, lng: o.lng };
}

function asRouteEndpointsByDay(stored: unknown): Record<string, RouteEndpoint> {
  if (!stored || typeof stored !== "object") return {};
  const out: Record<string, RouteEndpoint> = {};
  for (const [day, v] of Object.entries(stored as Record<string, unknown>)) {
    const ep = sanitizeRouteEndpoint(v);
    if (ep) out[day] = ep;
  }
  return out;
}

export async function getRouteEndpointsByDay(): Promise<{ start: Record<string, RouteEndpoint>; end: Record<string, RouteEndpoint> }> {
  const row = await prefsSelect<{ route_start: unknown; route_end: unknown }>("route_start,route_end");
  if (!row) return { start: {}, end: {} };
  return { start: asRouteEndpointsByDay(row.route_start), end: asRouteEndpointsByDay(row.route_end) };
}

export async function setRouteStartByDay(byDay: Record<string, RouteEndpoint>): Promise<void> {
  await prefsPatch({ route_start: byDay });
}

export async function setRouteEndByDay(byDay: Record<string, RouteEndpoint>): Promise<void> {
  await prefsPatch({ route_end: byDay });
}

// --- Last location, last odometer ---------------------------------------

export type LastLocation = { lat: number; lng: number; at: string };

export async function getLastLocation(): Promise<LastLocation | null> {
  const row = await prefsSelect<{ last_location: unknown }>("last_location");
  const v = row?.last_location as Partial<LastLocation> | null | undefined;
  if (!v || typeof v.lat !== "number" || typeof v.lng !== "number" || typeof v.at !== "string") return null;
  return { lat: v.lat, lng: v.lng, at: v.at };
}

export async function setLastLocation(lat: number, lng: number): Promise<void> {
  await prefsPatch({ last_location: { lat, lng, at: new Date().toISOString() } });
}

export type LastRouteOdo = { value: string; at: string };

export async function getLastRouteOdo(): Promise<LastRouteOdo | null> {
  const row = await prefsSelect<{ last_route_odo: unknown }>("last_route_odo");
  const v = row?.last_route_odo as Partial<LastRouteOdo> | null | undefined;
  if (!v || typeof v.value !== "string") return null;
  return { value: v.value, at: typeof v.at === "string" ? v.at : "" };
}

export async function setLastRouteOdo(value: string): Promise<void> {
  await prefsPatch({ last_route_odo: { value, at: new Date().toISOString() } });
}

// --- Mileage by day (widget odometer photos) -----------------------------

export type RouteMileageSide = {
  odo: string | null;
  driveFileId: string;
  photoLink: string;
  capturedAt: string;
  manual?: boolean;
};

export type RouteMileageDay = {
  start?: RouteMileageSide;
  end?: RouteMileageSide;
  filedSheetLink?: string;
  fileError?: string;
};

export async function getRouteMileageByDay(): Promise<Record<string, RouteMileageDay>> {
  const row = await prefsSelect<{ route_mileage: unknown }>("route_mileage");
  return (row?.route_mileage as Record<string, RouteMileageDay> | null) ?? {};
}

export async function setRouteMileageDay(day: string, patch: Partial<RouteMileageDay>): Promise<Record<string, RouteMileageDay>> {
  const byDay = await getRouteMileageByDay();
  const current = byDay[day] ?? {};
  const next: RouteMileageDay = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (next as Record<string, unknown>)[k];
    else (next as Record<string, unknown>)[k] = v;
  }
  const updated = { ...byDay, [day]: next };
  await prefsPatch({ route_mileage: updated });
  return updated;
}

export type { CustomStop };
