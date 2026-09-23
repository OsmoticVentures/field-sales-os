/**
 * Minimal Google Places (New) Text Search client, scoped to Fuel Routing's
 * one need: turn a typed destination ("Trader Joe's, Long Beach") into a
 * point OSRM can route to. Trimmed from
 * portfolio/src/app/nutribiotic/lib/places.ts's searchPlaces, same endpoint,
 * same field mask shape, same NB_PLACES_API_KEY.
 *
 * research/feature-inventory.md places the Places client in shared core
 * (`src/lib/shared` in this repo), but that folder is off limits during a
 * parallel port (PORTING.md, m8f concurrency rules). This is a feature-local
 * copy, not the shared client: LIFT THIS TO src/lib/shared in the
 * integration pass, once every feature that needs Places has landed, rather
 * than each port keeping its own.
 *
 * No hard geographic bounding box here (unlike the nutribiotic source, which
 * hard-restricts to California for its own accounts search): Fuel Routing
 * prices a fill-up on whatever drive is typed in, so this only biases toward
 * the rep's current location.
 */
import "server-only";

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

const FIELD_MASK = ["places.id", "places.displayName", "places.formattedAddress", "places.location"].join(",");

export type Dest = { lat: number; lng: number; address: string; label: string };

type RawPlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
};

export async function resolveDestination(query: string, near: { lat: number; lng: number }): Promise<Dest | null> {
  const key = process.env.NB_PLACES_API_KEY ?? "";
  if (!key) throw new Error("NB_PLACES_API_KEY is not configured on this deployment.");

  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: 5,
      languageCode: "en",
      regionCode: "US",
      locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50_000 } },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Places HTTP ${res.status}`);

  const data = (await res.json()) as { places?: RawPlace[] };
  const p = (data.places ?? [])[0];
  if (!p || p.location?.latitude == null || p.location?.longitude == null) return null;
  return {
    lat: p.location.latitude,
    lng: p.location.longitude,
    address: p.formattedAddress ?? p.displayName?.text ?? query,
    label: p.displayName?.text || query,
  };
}
