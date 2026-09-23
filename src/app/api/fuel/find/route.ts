/**
 * Price a fill-up along a real drive: real OSRM routing, live Places prices
 * sampled along the route already planned (not a radius around the rep), a
 * second OSRM table call for the true detour cost, top three by all-in cost.
 * Ported from portfolio/src/app/gas/actions.ts's findGas, converted from a
 * Server Action to a route handler (per PORTING.md, m8f: this app's
 * static-export target hard-stops on any Server Action, no per-route
 * opt-out).
 *
 * Read-only: no row is created, so no Idempotency-Key is required (same
 * shape as api/expenses/classify, PORTING.md's read-only carve-out).
 */
import { headers } from "next/headers";
import { hasAccess } from "../../../../lib/core/devices";
import { resolveDestination, type Dest } from "../../../../lib/features/fuel/destination";
import { RATE_CHEAPEST, RATE_QUICKEST, RESERVE_MILES, TANK_GALLONS } from "../../../../lib/features/fuel/constants";
import { fuelNearby } from "../../../../lib/features/fuel/stations";
import { detourMinutes, milesFromOrigin, route, sampleAlong, type LatLng } from "../../../../lib/features/fuel/osrm";
import { scoreStations, type Scored, type Station } from "../../../../lib/features/fuel/score";

export const runtime = "nodejs";
export const maxDuration = 60;

type DestInput = { lat: number; lng: number; address: string; label: string } | { query: string };

type FindBody = {
  origin: LatLng;
  dest: DestInput;
  gallons: number;
  quickest: boolean;
  /** Typed straight off the dashboard, not inferred from the tank gauge. */
  milesToEmpty?: number | null;
};

/* Every search is a handful of paid Places calls: one shared per-IP budget
   keeps a stray retry loop from running up the bill. */
const WINDOW_MS = 10 * 60 * 1000;
const BUDGET = 30;
const hits = new Map<string, number[]>();
function overBudget(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > BUDGET;
}

/* Circles overlap along the road: at nine samples a 40-mile drive gets a
   search every ~4.5 miles with a 3-mile radius. Each sample is one paid
   Places call, so this is the whole per-search cost. */
const MAX_SAMPLES = 9;
const MAX_RESULTS = 60;

async function resolveDest(input: DestInput, origin: LatLng): Promise<Dest | { error: string }> {
  if (!("query" in input)) return input;
  const q = input.query.trim();
  if (!q) return { error: "Type where you're going." };
  let found: Dest | null;
  try {
    found = await resolveDestination(q, origin);
  } catch {
    return { error: "Couldn't look up that place. Try again." };
  }
  if (!found) return { error: `Couldn't find "${q}". Try an address or a city.` };
  return found;
}

async function planRoute(origin: LatLng, dest: LatLng) {
  const shape = await route(origin, dest);
  if (!shape) return null;
  const totalMeters = shape.miles * 1609.344;
  const samples = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(totalMeters / 6000) + 1));
  const centers = sampleAlong(shape.coords, samples);
  const step = totalMeters / Math.max(1, samples - 1);
  const radius = Math.min(6000, Math.max(2500, step * 0.7));
  return { shape, centers, radius };
}

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (overBudget(ip)) {
    return Response.json({ ok: false, error: "Too many searches in a row. Try again in a few minutes." });
  }

  let body: FindBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "That request didn't parse." }, { status: 400 });
  }

  const gallons = Math.min(TANK_GALLONS, Math.max(0.5, Number(body.gallons) || 0));
  const origin = body.origin;
  if (!Number.isFinite(origin?.lat) || !Number.isFinite(origin?.lng)) {
    return Response.json({ ok: false, error: "No location yet." });
  }

  const dest = await resolveDest(body.dest, origin);
  if ("error" in dest) return Response.json({ ok: false, error: dest.error });

  const plan = await planRoute(origin, dest);
  if (!plan) return Response.json({ ok: false, error: "Couldn't get a road route right now. Try again." });
  const { shape, centers, radius } = plan;

  const batches = await Promise.allSettled(centers.map((c) => fuelNearby(c, radius)));
  const seen = new Map<string, Station>();
  let anyOk = false;
  for (const b of batches) {
    if (b.status !== "fulfilled") continue;
    anyOk = true;
    for (const s of b.value) if (!seen.has(s.id)) seen.set(s.id, s);
  }
  if (!anyOk) return Response.json({ ok: false, error: "Couldn't read gas prices right now. Try again." });
  let stations = [...seen.values()].sort((a, b) => a.regular - b.regular).slice(0, MAX_RESULTS);
  if (stations.length === 0) return Response.json({ ok: false, error: "No stations with a posted price along this drive." });

  const milesToEmpty = Number(body.milesToEmpty);
  if (Number.isFinite(milesToEmpty) && milesToEmpty > 0) {
    const reach = milesToEmpty - RESERVE_MILES;
    if (reach <= 0) {
      return Response.json({ ok: false, error: `That leaves no room past the ${RESERVE_MILES}-mile reserve.` });
    }
    const originMiles = await milesFromOrigin(origin, stations);
    if (!originMiles) return Response.json({ ok: false, error: "Couldn't check which stations are in reach right now. Try again." });
    stations = stations.filter((_, i) => originMiles[i] <= reach);
    if (stations.length === 0) {
      return Response.json({ ok: false, error: `No priced station within ${Math.round(reach)} miles.` });
    }
  }

  const detours = await detourMinutes(origin, dest, stations);
  if (!detours) return Response.json({ ok: false, error: "Couldn't time the detours right now. Try again." });

  const rate = body.quickest ? RATE_QUICKEST : RATE_CHEAPEST;
  const scored: Scored[] = scoreStations(stations, detours, gallons, rate);
  return Response.json({ ok: true, dest, directMinutes: shape.minutes, considered: scored.length, gallons, best: scored.slice(0, 3) });
}
