/**
 * The one Google Places (New) Text Search client. Ported from the NutriBiotic
 * OS (portfolio/src/app/nutribiotic/lib/places.ts) and lifted here from the
 * per-feature copies Prospect, Fuel Routing and Route Planner each carried
 * during the parallel port. Same endpoint, same NB_PLACES_API_KEY.
 *
 * `textSearch` is the raw call: a query, a field mask, an optional bias or
 * restriction. The named helpers under it are the shapes each feature reads:
 *   - searchPlaces      Prospect's full candidate (hours, phone, website),
 *                        California-restricted, ranked by distance when a
 *                        `near` is given.
 *   - resolveDestination Fuel Routing's one point to route to, biased to the
 *                        rep's location, no hard box.
 *   - resolveStopAddress / searchRouteAddresses
 *                        Route Planner's lunch/hotel/other stop, biased to
 *                        Southern California.
 * Each keeps exactly the request its feature made before the lift.
 */
import "server-only";

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

export type LatLng = { lat: number; lng: number };

export type RawPlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: Array<{ types?: string[]; longText?: string; shortText?: string }>;
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  websiteUri?: string;
  businessStatus?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
  regularOpeningHours?: { periods?: Array<{ open?: { day?: number; hour?: number; minute?: number }; close?: { hour?: number; minute?: number } }> };
};

type Rectangle = { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } };

export type TextSearchOptions = {
  textQuery: string;
  fieldMask: string[];
  maxResultCount: number;
  locationBias?: { rectangle: Rectangle } | { circle: { center: { latitude: number; longitude: number }; radius: number } };
  locationRestriction?: { rectangle: Rectangle };
  timeoutMs?: number;
};

export class PlacesError extends Error {}

/** The raw call. Throws PlacesError when the key is missing or Google
 *  answers with anything but 200; callers decide whether that is fatal. */
export async function textSearch(opts: TextSearchOptions): Promise<RawPlace[]> {
  const key = process.env.NB_PLACES_API_KEY ?? "";
  if (!key) throw new PlacesError("NB_PLACES_API_KEY is not configured on this deployment.");

  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": opts.fieldMask.join(","),
    },
    body: JSON.stringify({
      textQuery: opts.textQuery,
      maxResultCount: opts.maxResultCount,
      languageCode: "en",
      regionCode: "US",
      ...(opts.locationBias ? { locationBias: opts.locationBias } : {}),
      ...(opts.locationRestriction ? { locationRestriction: opts.locationRestriction } : {}),
    }),
    cache: "no-store",
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  });
  if (!res.ok) {
    throw new PlacesError(`Places HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { places?: RawPlace[] };
  return data.places ?? [];
}

/** Great-circle distance in km, for ranking results by proximity. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// Prospect: the full candidate
// ---------------------------------------------------------------------------

const CANDIDATE_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.regularOpeningHours.periods",
  "places.businessStatus",
  "places.rating",
  "places.userRatingCount",
  "places.primaryType",
];

export type PlaceCandidate = {
  placeId: string;
  name: string;
  formattedAddress: string | null;
  street: string | null;
  city: string | null;
  neighborhood: string | null;
  state: string | null;
  postal: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
  businessStatus: string | null;
  businessHours: Record<string, string[][]> | null;
  rating: number | null;
  ratingCount: number | null;
  primaryType: string | null;
};

function component(place: RawPlace, kind: string): string | null {
  for (const c of place.addressComponents ?? []) {
    if ((c.types ?? []).includes(kind)) return c.longText || c.shortText || null;
  }
  return null;
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function openingHours(place: RawPlace): Record<string, string[][]> | null {
  const periods = place.regularOpeningHours?.periods ?? [];
  if (periods.length === 0) return null;
  const out: Record<string, string[][]> = Object.fromEntries(DAYS.map((d) => [d, []]));
  const fmt = (h?: number, m?: number) => `${String(h ?? 0).padStart(2, "0")}:${String(m ?? 0).padStart(2, "0")}`;
  for (const p of periods) {
    const day = p.open?.day;
    if (day == null) continue;
    out[DAYS[day]].push([fmt(p.open?.hour, p.open?.minute), p.close ? fmt(p.close.hour, p.close.minute) : "23:59"]);
  }
  return out;
}

/** "(657) 655-4420" -> "657-655-4420", the format nb_accounts.phone is stored
 *  in. Anything that doesn't parse as a US 10-digit number passes through. */
function normalizePhone(raw: string | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "").replace(/^1/, "");
  if (digits.length !== 10) return raw;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function toCandidate(place: RawPlace): PlaceCandidate {
  return {
    placeId: place.id ?? "",
    name: place.displayName?.text ?? "",
    formattedAddress: place.formattedAddress ?? null,
    street: [component(place, "street_number"), component(place, "route")].filter(Boolean).join(" ") || null,
    city: component(place, "locality"),
    neighborhood: component(place, "neighborhood") ?? component(place, "sublocality"),
    state: component(place, "administrative_area_level_1"),
    postal: component(place, "postal_code"),
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    phone: normalizePhone(place.nationalPhoneNumber),
    website: place.websiteUri ?? null,
    businessStatus: place.businessStatus ?? null,
    businessHours: openingHours(place),
    rating: place.rating ?? null,
    ratingCount: place.userRatingCount ?? null,
    primaryType: place.primaryType ?? null,
  };
}

/** California's bounding box, generous rather than exact. Juan's whole book
 *  is Southern California; an out-of-state result is never useful. */
const CALIFORNIA_BOUNDS: Rectangle = {
  low: { latitude: 32.4, longitude: -124.6 },
  high: { latitude: 42.1, longitude: -114.0 },
};

/**
 * Top few candidates for a free-text query. California is a hard rule,
 * always: the request keeps `locationRestriction` on every call and, when
 * `near` is given, over-fetches and re-sorts by real distance instead of
 * trading the hard rectangle away for a soft bias circle.
 */
export async function searchPlaces(query: string, maxResults = 3, near?: LatLng): Promise<PlaceCandidate[]> {
  const fetchCount = near ? Math.min(Math.max(maxResults * 3, 10), 20) : maxResults;
  const places = await textSearch({
    textQuery: query,
    fieldMask: CANDIDATE_FIELD_MASK,
    maxResultCount: fetchCount,
    locationRestriction: { rectangle: CALIFORNIA_BOUNDS },
  });
  let candidates = places.map(toCandidate);
  if (near) {
    candidates = candidates
      .map((c) => ({ c, d: c.lat != null && c.lng != null ? haversineKm(near, { lat: c.lat, lng: c.lng }) : Infinity }))
      .sort((x, y) => x.d - y.d)
      .map((x) => x.c);
  }
  return candidates.slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Fuel Routing: one destination point
// ---------------------------------------------------------------------------

const POINT_FIELD_MASK = ["places.id", "places.displayName", "places.formattedAddress", "places.location"];

export type Dest = { lat: number; lng: number; address: string; label: string };

/** Turn a typed destination ("Trader Joe's, Long Beach") into a point OSRM
 *  can route to. No hard geographic box: a fill-up is priced on whatever
 *  drive is typed in, so this only biases toward the rep's location. */
export async function resolveDestination(query: string, near: LatLng): Promise<Dest | null> {
  const places = await textSearch({
    textQuery: query,
    fieldMask: POINT_FIELD_MASK,
    maxResultCount: 5,
    locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius: 50_000 } },
    timeoutMs: 10_000,
  });
  const p = places[0];
  if (!p || p.location?.latitude == null || p.location?.longitude == null) return null;
  return {
    lat: p.location.latitude,
    lng: p.location.longitude,
    address: p.formattedAddress ?? p.displayName?.text ?? query,
    label: p.displayName?.text || query,
  };
}

// ---------------------------------------------------------------------------
// Route Planner: a lunch, hotel or other stop
// ---------------------------------------------------------------------------

const SOCAL_BIAS: Rectangle = {
  low: { latitude: 32.4, longitude: -119.6 },
  high: { latitude: 35.6, longitude: -115.9 },
};

const STOP_FIELD_MASK = ["places.displayName", "places.formattedAddress", "places.location"];

export type ResolvedPlace = { label: string; address: string; lat: number; lng: number };

function toResolved(hit: RawPlace, q: string): ResolvedPlace | null {
  const lat = hit.location?.latitude;
  const lng = hit.location?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return { label: hit.displayName?.text?.trim() || hit.formattedAddress || q, address: hit.formattedAddress || q, lat, lng };
}

/** Nothing is written here; a stop only exists once it is added to a day's
 *  draft. Errors come back as a plain message the form shows as is. */
export async function resolveStopAddress(query: string): Promise<{ ok: true; place: ResolvedPlace } | { ok: false; error: string }> {
  const q = query.trim();
  if (q.length < 3) return { ok: false, error: "Type an address or a place name." };
  if (!process.env.NB_PLACES_API_KEY) return { ok: false, error: "Address lookup is not set up yet." };

  let places: RawPlace[];
  try {
    places = await textSearch({ textQuery: q, fieldMask: STOP_FIELD_MASK, maxResultCount: 1, locationBias: { rectangle: SOCAL_BIAS } });
  } catch (e) {
    return { ok: false, error: e instanceof PlacesError ? "Address lookup failed." : "Couldn't reach the address lookup." };
  }
  const place = places[0] ? toResolved(places[0], q) : null;
  if (!place) return { ok: false, error: "No match. Add the city, or paste the full address." };
  return { ok: true, place };
}

export async function searchRouteAddresses(query: string): Promise<ResolvedPlace[]> {
  const q = query.trim();
  if (q.length < 3 || !process.env.NB_PLACES_API_KEY) return [];
  let places: RawPlace[];
  try {
    places = await textSearch({ textQuery: q, fieldMask: STOP_FIELD_MASK, maxResultCount: 5, locationBias: { rectangle: SOCAL_BIAS } });
  } catch {
    return [];
  }
  return places.map((hit) => toResolved(hit, q)).filter((p): p is ResolvedPlace => p !== null);
}
