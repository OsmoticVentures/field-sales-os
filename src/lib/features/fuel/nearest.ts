import "server-only";
import { fuelNearby } from "./stations";
import { haversineMeters, milesFromOrigin, type LatLng } from "./osrm";
import type { Station } from "./score";

export type NearStation = Station & { milesAway: number };

/* Tight first, widening only when fewer than three priced stations turn up. */
const RADII_METERS = [3200, 8000, 16000, 32000];
/* The closest few by air distance are the candidates; price ranks within them. */
const CANDIDATES = 10;

/** The three cheapest stations among the closest ones to the origin. Only
 *  stations with a live Google price are candidates, and a distance Google's
 *  road table can't confirm drops the station rather than being guessed. */
export async function nearestCheapest(origin: LatLng): Promise<NearStation[] | null> {
  let found: Station[] = [];
  for (const r of RADII_METERS) {
    found = await fuelNearby(origin, r);
    if (found.length >= 3) break;
  }
  if (found.length === 0) return [];
  const air = (s: Station) => haversineMeters([origin.lng, origin.lat], [s.lng, s.lat]);
  const close = [...found].sort((a, b) => air(a) - air(b)).slice(0, CANDIDATES);
  const miles = await milesFromOrigin(origin, close);
  if (!miles) return null;
  const withMiles: NearStation[] = [];
  close.forEach((s, i) => {
    if (Number.isFinite(miles[i])) withMiles.push({ ...s, milesAway: miles[i] });
  });
  return withMiles.sort((a, b) => a.regular - b.regular || a.milesAway - b.milesAway).slice(0, 3);
}
