/**
 * Gas stations with a live regular-unleaded price, from Google Places
 * (New) Nearby Search. Ported unchanged from portfolio/src/app/gas/lib/fuel.ts.
 */
import "server-only";
import type { Station } from "./score";

const NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.shortFormattedAddress",
  "places.location",
  "places.fuelOptions",
  "places.currentOpeningHours.openNow",
].join(",");

type RawPlace = {
  id?: string;
  displayName?: { text?: string };
  shortFormattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  currentOpeningHours?: { openNow?: boolean };
  fuelOptions?: {
    fuelPrices?: Array<{
      type?: string;
      price?: { units?: string; nanos?: number };
      updateTime?: string;
    }>;
  };
};

/* Warehouse-club pumps need a membership card at the pump, so their price is
   not a price that's actually available at the pump. */
const MEMBERS_ONLY = /costco|sam[’']?s club/i;

/** Gas stations around one point, keeping only those Google has a live
 *  regular-unleaded price for. A station with no price is not a candidate:
 *  showing it would mean inventing a number. Closed stations are dropped. */
export async function fuelNearby(
  center: { lat: number; lng: number },
  radiusMeters: number,
): Promise<Station[]> {
  const key = process.env.NB_PLACES_API_KEY ?? "";
  if (!key) throw new Error("NB_PLACES_API_KEY is not configured on this deployment.");

  const res = await fetch(NEARBY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK },
    body: JSON.stringify({
      includedTypes: ["gas_station"],
      maxResultCount: 20,
      languageCode: "en",
      regionCode: "US",
      locationRestriction: {
        circle: { center: { latitude: center.lat, longitude: center.lng }, radius: Math.min(50_000, Math.max(500, radiusMeters)) },
      },
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Places HTTP ${res.status}`);

  const data = (await res.json()) as { places?: RawPlace[] };
  const out: Station[] = [];
  for (const p of data.places ?? []) {
    if (p.currentOpeningHours?.openNow === false) continue;
    if (MEMBERS_ONLY.test(p.displayName?.text ?? "")) continue;
    const lat = p.location?.latitude;
    const lng = p.location?.longitude;
    if (!p.id || lat == null || lng == null) continue;
    const reg = (p.fuelOptions?.fuelPrices ?? []).find((f) => f.type === "REGULAR_UNLEADED");
    if (!reg?.price?.units) continue;
    const regular = Number(reg.price.units) + (reg.price.nanos ?? 0) / 1e9;
    if (!Number.isFinite(regular) || regular <= 0) continue;
    out.push({
      id: p.id,
      name: p.displayName?.text ?? "Gas station",
      address: p.shortFormattedAddress ?? "",
      lat,
      lng,
      regular,
      updatedAt: reg.updateTime ?? "",
    });
  }
  return out;
}
