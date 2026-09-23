/**
 * Road time between consecutive stops on the hand-built route. Ported from
 * the NutriBiotic OS (portfolio/src/app/nutribiotic/map/drive-actions.ts),
 * with "use server" dropped: this repo has no Server Actions (PORTING.md),
 * so these are plain server-only functions called from
 * src/app/api/route/drive/route.ts.
 *
 * WHY OSRM AND NOT GOOGLE ROUTES. The Routes API needs a per-element billed
 * matrix call on a screen reloaded all day; OSRM's public server is free,
 * needs no key, and routes on the real street network.
 *
 * WHAT THE NUMBER HONESTLY IS. OSRM returns FREE-FLOW time; it does not know
 * today's traffic. The raw duration is multiplied by TRAFFIC_FACTOR (the
 * flat calibration) or repriced per leg by traffic.ts's time-of-day curve,
 * and labelled a planning estimate, never an ETA.
 *
 * FAILURE IS SILENT AND VISIBLE AT ONCE: a null return means the caller
 * falls back to straight-line hops (route-optimize.ts's haversineMatrix) and
 * says drive times are unavailable. It never invents a leg.
 */
import "server-only";
import type { DriveLeg } from "./types";

const OSRM = "https://router.project-osrm.org";

/** LA surface-street and freeway reality against OSRM's free-flow model, in
 *  the 09:00-16:00 window this screen plans for. Kept exactly as calibrated
 *  in the source app. */
export const TRAFFIC_FACTOR = 1.35;

const MAX_STOPS = 25;

export async function routeDriveLegs(points: { lat: number; lng: number }[]): Promise<DriveLeg[] | null> {
  if (points.length < 2 || points.length > MAX_STOPS) return null;
  if (points.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lng))) return null;

  const path = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${OSRM}/route/v1/driving/${path}?overview=false&annotations=false`;

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data: { code?: string; routes?: { legs?: { duration?: number; distance?: number }[] }[] };
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (data.code !== "Ok") return null;

  const legs = data.routes?.[0]?.legs;
  if (!legs || legs.length !== points.length - 1) return null;

  const out: DriveLeg[] = [];
  for (const l of legs) {
    if (typeof l.duration !== "number" || typeof l.distance !== "number") return null;
    out.push({
      minutes: (l.duration * TRAFFIC_FACTOR) / 60,
      freeFlowMinutes: l.duration / 60,
      miles: l.distance / 1609.344,
    });
  }
  return out;
}

export async function routeDriveMatrix(points: { lat: number; lng: number }[]): Promise<number[][] | null> {
  if (points.length < 2 || points.length > MAX_STOPS) return null;
  if (points.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lng))) return null;

  const path = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${OSRM}/table/v1/driving/${path}?annotations=distance`;

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let data: { code?: string; distances?: (number | null)[][] };
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (data.code !== "Ok" || !Array.isArray(data.distances)) return null;
  if (data.distances.length !== points.length) return null;
  for (const row of data.distances) {
    if (!Array.isArray(row) || row.length !== points.length) return null;
    if (row.some((v) => typeof v !== "number" || !Number.isFinite(v))) return null;
  }
  return data.distances as number[][];
}
