/**
 * A store the note named that is not in the book yet: its HubSpot company
 * (duplicate-checked across the portal first) and its OS account, enriched
 * from Google Places: the nearest result carrying the name, within 3 km of
 * where the phone was when Log was tapped, or the only one when the phone
 * gave no location. Returns the new account and the store type Places
 * suggests; the Visit screen files the note to it, then asks the type.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { createCompany, findPossibleDuplicates } from "../../../../lib/features/visit/hubspot-company";
import { writeEnabled } from "../../../../lib/features/visit/hubspot";
import { searchPlaces, type LatLng, type PlaceCandidate } from "../../../../lib/shared/places";
import { insertBareAccount } from "../../../../lib/features/visit/dal";

export const runtime = "nodejs";
export const maxDuration = 60;

const STOP = new Set(["the", "of", "at", "in", "and", "on", "a"]);
const words = (v: string) =>
  v.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));

/** The note's name carries the place's name: two of its words, or its only
 *  one ("JONS fresh marketplace of Torrance" carries "JONS Fresh Marketplace
 *  #04"; "the vitamin zone" does not carry "The Vitamin Shoppe"). */
function carries(said: string, placeName: string): boolean {
  const have = new Set(words(said));
  const theirs = words(placeName).filter((w) => !/^\d+$/.test(w));
  if (theirs.length === 0) return false;
  return theirs.filter((w) => have.has(w)).length >= Math.min(2, theirs.length);
}

function km(a: LatLng, b: LatLng): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

/** The house channel a Places type plainly names; anything else is his pick. */
const CHANNEL_BY_TYPE: Record<string, string> = {
  grocery_store: "grocery", supermarket: "grocery", health_food_store: "grocery", food_store: "grocery", market: "grocery",
  pharmacy: "pharmacy", drugstore: "pharmacy",
  gym: "gym", fitness_center: "gym",
  beauty_salon: "spa_beauty", spa: "spa_beauty", hair_salon: "spa_beauty", nail_salon: "spa_beauty", skin_care_clinic: "spa_beauty",
  doctor: "clinic", medical_clinic: "clinic", chiropractor: "clinic", physiotherapist: "clinic", dentist: "clinic", wellness_center: "clinic",
  pet_store: "pet_specialty",
};

function pickPlace(found: PlaceCandidate[], name: string, near: LatLng | null): PlaceCandidate | null {
  const hits = found.filter((c) => carries(name, c.name) && !(c.businessStatus ?? "").startsWith("CLOSED"));
  if (near) {
    const close = hits
      .filter((c) => c.lat != null && c.lng != null)
      .map((c) => ({ c, d: km(near, { lat: c.lat!, lng: c.lng! }) }))
      .filter((x) => x.d <= 3)
      .sort((x, y) => x.d - y.d);
    return close[0]?.c ?? null;
  }
  return hits.length === 1 ? hits[0] : null;
}

async function enrichFromPlaces(name: string, city: string | null, near: LatLng | null): Promise<Record<string, unknown> | null> {
  try {
    const found = await searchPlaces(city ? `${name} ${city}` : name, near ? 5 : 3, near ?? undefined);
    const c = pickPlace(found, name, near);
    if (!c) return null;
    const row: Record<string, unknown> = {
      street: c.street, city: c.city, state: c.state, postal: c.postal, lat: c.lat, lng: c.lng,
      phone: c.phone, website: c.website, business_hours: c.businessHours,
      places_id: c.placeId, places_rating: c.rating, places_rating_count: c.ratingCount, places_primary_type: c.primaryType,
      places_status: c.businessStatus, channel: c.primaryType ? CHANNEL_BY_TYPE[c.primaryType] : null,
    };
    return Object.fromEntries(Object.entries(row).filter(([, v]) => v != null));
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const key = idempotencyKey(req);
  if (!key) {
    return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const name = (body?.name as string | undefined)?.trim();
  if (!name) {
    return Response.json({ ok: false, error: "A business name is required." }, { status: 400 });
  }
  const city = (body?.city as string | undefined) || null;
  const n = body?.near as { lat?: unknown; lng?: unknown } | undefined;
  const near: LatLng | null =
    typeof n?.lat === "number" && typeof n?.lng === "number" && Number.isFinite(n.lat) && Number.isFinite(n.lng) ? { lat: n.lat, lng: n.lng } : null;
  // Search picked one exact Places result: use it as is, no re-guessing.
  const p = body?.place as Record<string, unknown> | undefined;
  const chosen: Record<string, unknown> | null = p?.placeId
    ? Object.fromEntries(
        Object.entries({
          street: p.street, city: p.city, state: p.state, postal: p.postal, lat: p.lat, lng: p.lng,
          phone: p.phone, website: p.website, business_hours: p.businessHours,
          places_id: p.placeId, places_rating: p.rating, places_rating_count: p.ratingCount, places_primary_type: p.primaryType,
          channel: typeof p.primaryType === "string" ? CHANNEL_BY_TYPE[p.primaryType] : null,
        }).filter(([, v]) => v != null),
      )
    : null;

  try {
    const { result, replayed } = await withIdempotency(`visit:new-account:${key}`, async () => {
      // First pass for a new business: enrich from Google Places BEFORE the
      // HubSpot company exists, so the company is born with its address,
      // phone and website. Accepted only when exactly one result carries the
      // typed name; anything ambiguous stays a bare account (never a guess).
      const enriched = chosen ?? (await enrichFromPlaces(name, city, near));
      const site = enriched?.website as string | undefined;
      // The portal-wide duplicate check runs first; any hit blocks the
      // create, since a second company for a store the other rep already
      // has is the one mistake nothing local can catch.
      let companyId: string | null = null;
      if (writeEnabled("visit")) {
        const dupes = await findPossibleDuplicates(name, site);
        if (dupes.length > 0) {
          const names = dupes.slice(0, 3).map((d) => [d.name, d.city].filter(Boolean).join(", ")).join("; ");
          throw new Error(`${name} may already be in HubSpot (${names}). Nothing created. Search for it instead.`);
        }
        companyId = await createCompany({
          name,
          city: (enriched?.city as string | undefined) ?? city,
          state: enriched?.state as string | undefined,
          street: enriched?.street as string | undefined,
          postal: enriched?.postal as string | undefined,
          phone: enriched?.phone as string | undefined,
          website: site,
        });
      }
      const account = await insertBareAccount({ name, city, hubspot_company_id: companyId, enriched: enriched ?? undefined });
      return { accountId: account.id, accountName: account.name, channel: (enriched?.channel as string | undefined) ?? null };
    });
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not create that account." }, { status: 500 });
  }
}
