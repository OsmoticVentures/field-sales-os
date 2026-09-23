/**
 * Road routing and detour timing via OSRM. Ported unchanged from
 * portfolio/src/app/gas/lib/osrm.ts.
 */
import "server-only";

/* Same router and the same free-flow correction the NutriBiotic map uses
   (nutribiotic/map/drive-actions.ts). The factor cancels out of a detour
   ranking; it stays so the minutes on screen read like a real drive. */
const OSRM = "https://router.project-osrm.org";
const TRAFFIC_FACTOR = 1.35;

export type LatLng = { lat: number; lng: number };

export type RouteShape = {
  minutes: number;
  miles: number;
  /** [lng, lat] pairs along the road. */
  coords: [number, number][];
};

export async function route(origin: LatLng, dest: LatLng): Promise<RouteShape | null> {
  const url = `${OSRM}/route/v1/driving/${origin.lng},${origin.lat};${dest.lng},${dest.lat}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: string;
      routes?: { duration?: number; distance?: number; geometry?: { coordinates?: [number, number][] } }[];
    };
    const r = data.routes?.[0];
    if (data.code !== "Ok" || !r || typeof r.duration !== "number" || typeof r.distance !== "number") return null;
    return {
      minutes: (r.duration * TRAFFIC_FACTOR) / 60,
      miles: r.distance / 1609.344,
      coords: r.geometry?.coordinates ?? [],
    };
  } catch {
    return null;
  }
}

/** Minutes from origin through each station to dest, minus the straight
 *  drive: one table call, every station priced against the same baseline. */
export async function detourMinutes(origin: LatLng, dest: LatLng, stations: LatLng[]): Promise<number[] | null> {
  if (stations.length === 0) return [];
  const pts = [origin, dest, ...stations];
  const path = pts.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${OSRM}/table/v1/driving/${path}?annotations=duration`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { code?: string; durations?: (number | null)[][] };
    const d = data.durations;
    if (data.code !== "Ok" || !d || d.length !== pts.length) return null;
    const direct = d[0][1];
    if (typeof direct !== "number") return null;
    return stations.map((_, i) => {
      const k = i + 2;
      const a = d[0][k];
      const b = d[k][1];
      if (typeof a !== "number" || typeof b !== "number") return NaN;
      return ((a + b - direct) * TRAFFIC_FACTOR) / 60;
    });
  } catch {
    return null;
  }
}

/** Road miles from origin to each point, one table call with a single
 *  source row. Used only to drop stations a low tank can't physically reach,
 *  never to rank them, that's still detourMinutes. */
export async function milesFromOrigin(origin: LatLng, points: LatLng[]): Promise<number[] | null> {
  if (points.length === 0) return [];
  const pts = [origin, ...points];
  const path = pts.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${OSRM}/table/v1/driving/${path}?sources=0&annotations=distance`;
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { code?: string; distances?: (number | null)[][] };
    const row = data.distances?.[0];
    if (data.code !== "Ok" || !row) return null;
    return points.map((_, i) => {
      const m = row[i + 1];
      return typeof m === "number" ? m / 1609.344 : NaN;
    });
  } catch {
    return null;
  }
}

/** Points spread evenly along the road, origin first, at most `count`. */
export function sampleAlong(coords: [number, number][], count: number): LatLng[] {
  if (coords.length === 0) return [];
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineMeters(coords[i - 1], coords[i]));
  const total = cum[cum.length - 1];
  if (total === 0 || count <= 1) return [{ lng: coords[0][0], lat: coords[0][1] }];
  const out: LatLng[] = [];
  let j = 0;
  for (let n = 0; n < count; n++) {
    const target = (total * n) / (count - 1);
    while (j < cum.length - 1 && cum[j] < target) j++;
    out.push({ lng: coords[j][0], lat: coords[j][1] });
  }
  return out;
}

export function haversineMeters(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
