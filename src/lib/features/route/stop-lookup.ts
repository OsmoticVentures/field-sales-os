/**
 * Turning something typed ("hilton anaheim", "1234 Main St, Tustin") into a
 * stop with real coordinates. Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/stop-actions.ts), with "use server"
 * dropped: called from src/app/api/route/lookup/route.ts, not directly from
 * the client.
 *
 * PLACES, NOT GEOCODING, same NB_PLACES_API_KEY the account geocoder uses.
 * Nothing is written here; a stop only exists once it is added to a day's
 * draft.
 */
import "server-only";

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

const SOCAL_BIAS = {
  rectangle: {
    low: { latitude: 32.4, longitude: -119.6 },
    high: { latitude: 35.6, longitude: -115.9 },
  },
};

export type ResolvedPlace = { label: string; address: string; lat: number; lng: number };

type PlacesResponse = {
  places?: {
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
  }[];
};

export async function resolveStopAddress(
  query: string,
): Promise<{ ok: true; place: ResolvedPlace } | { ok: false; error: string }> {
  const q = query.trim();
  if (q.length < 3) return { ok: false, error: "Type an address or a place name." };

  const key = process.env.NB_PLACES_API_KEY;
  if (!key) return { ok: false, error: "Address lookup is not set up yet." };

  let res: Response;
  try {
    res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify({ textQuery: q, maxResultCount: 1, regionCode: "US", locationBias: SOCAL_BIAS }),
      cache: "no-store",
    });
  } catch {
    return { ok: false, error: "Couldn't reach the address lookup." };
  }

  if (!res.ok) return { ok: false, error: "Address lookup failed." };

  const data = (await res.json()) as PlacesResponse;
  const hit = data.places?.[0];
  const lat = hit?.location?.latitude;
  const lng = hit?.location?.longitude;
  if (!hit || typeof lat !== "number" || typeof lng !== "number") {
    return { ok: false, error: "No match. Add the city, or paste the full address." };
  }

  return {
    ok: true,
    place: { label: hit.displayName?.text?.trim() || hit.formattedAddress || q, address: hit.formattedAddress || q, lat, lng },
  };
}

export async function searchRouteAddresses(query: string): Promise<ResolvedPlace[]> {
  const q = query.trim();
  if (q.length < 3) return [];

  const key = process.env.NB_PLACES_API_KEY;
  if (!key) return [];

  let res: Response;
  try {
    res = await fetch(PLACES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify({ textQuery: q, maxResultCount: 5, regionCode: "US", locationBias: SOCAL_BIAS }),
      cache: "no-store",
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];

  const data = (await res.json()) as PlacesResponse;
  return (data.places ?? [])
    .filter(
      (hit): hit is typeof hit & { location: { latitude: number; longitude: number } } =>
        typeof hit.location?.latitude === "number" && typeof hit.location?.longitude === "number",
    )
    .map((hit) => ({
      label: hit.displayName?.text?.trim() || hit.formattedAddress || q,
      address: hit.formattedAddress || q,
      lat: hit.location.latitude,
      lng: hit.location.longitude,
    }));
}
