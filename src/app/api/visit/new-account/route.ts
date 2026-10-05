/**
 * A store the note named that is not in the book yet: its HubSpot company
 * (duplicate-checked across the portal first) and its OS account, enriched
 * from Google Places when exactly one result carries the name. Returns the
 * new account; the Visit screen then files the note to it.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { createCompany, findPossibleDuplicates } from "../../../../lib/features/visit/hubspot-company";
import { writeEnabled } from "../../../../lib/features/visit/hubspot";
import { searchPlaces } from "../../../../lib/shared/places";
import { insertBareAccount } from "../../../../lib/features/visit/dal";

export const runtime = "nodejs";
export const maxDuration = 60;

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

async function enrichFromPlaces(name: string, city: string | null): Promise<Record<string, unknown> | null> {
  try {
    const found = await searchPlaces(city ? `${name} ${city}` : name, 3);
    const hits = found.filter((c) => norm(c.name).includes(norm(name)) && !(c.businessStatus ?? "").startsWith("CLOSED"));
    if (hits.length !== 1) return null;
    const c = hits[0];
    const row: Record<string, unknown> = {
      street: c.street, city: c.city, state: c.state, postal: c.postal, lat: c.lat, lng: c.lng,
      phone: c.phone, website: c.website, business_hours: c.businessHours,
      places_id: c.placeId, places_rating: c.rating, places_rating_count: c.ratingCount, places_primary_type: c.primaryType,
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
  // Search picked one exact Places result: use it as is, no re-guessing.
  const p = body?.place as Record<string, unknown> | undefined;
  const chosen: Record<string, unknown> | null = p?.placeId
    ? Object.fromEntries(
        Object.entries({
          street: p.street, city: p.city, state: p.state, postal: p.postal, lat: p.lat, lng: p.lng,
          phone: p.phone, website: p.website, business_hours: p.businessHours,
          places_id: p.placeId, places_rating: p.rating, places_rating_count: p.ratingCount, places_primary_type: p.primaryType,
        }).filter(([, v]) => v != null),
      )
    : null;

  try {
    const { result, replayed } = await withIdempotency(`visit:new-account:${key}`, async () => {
      // First pass for a new business: enrich from Google Places BEFORE the
      // HubSpot company exists, so the company is born with its address,
      // phone and website. Accepted only when exactly one result carries the
      // typed name; anything ambiguous stays a bare account (never a guess).
      const enriched = chosen ?? (await enrichFromPlaces(name, city));
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
      return { accountId: account.id, accountName: account.name };
    });
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not create that account." }, { status: 500 });
  }
}
