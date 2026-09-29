/**
 * Answers a touchpoint parked as needs_account: either a pick from Juan's
 * own book, or a bare new account (this port's stand-in for the source's
 * Google-Places-driven createBusinessFromPlace, see PORTING.md and the
 * port's handback).
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { createCompany, findPossibleDuplicates } from "../../../../lib/features/visit/hubspot-company";
import { writeEnabled } from "../../../../lib/features/visit/hubspot";
import { searchPlaces } from "../../../../lib/shared/places";
import { insertBareAccount } from "../../../../lib/features/visit/dal";
import { resolveTouchpointToAccount } from "../../../../lib/features/visit/touchpoint";

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
  const touchpointId = body?.touchpointId as string | undefined;
  if (!touchpointId) {
    return Response.json({ ok: false, error: "touchpointId is required." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`visit:resolve-account:${key}`, async () => {
      if (body?.mode === "create") {
        const name = (body?.name as string | undefined)?.trim();
        if (!name) throw new Error("A business name is required.");
        const city = (body?.city as string | undefined) || null;
        // First pass for a new business: enrich from Google Places BEFORE the
        // HubSpot company exists, so the company is born with its address,
        // phone and website. Accepted only when exactly one result carries the
        // typed name; anything ambiguous stays a bare account (never a guess).
        const enriched = await enrichFromPlaces(name, city);
        const site = enriched?.website as string | undefined;
        // A new store needs its HubSpot company before the visit can file.
        // The portal-wide duplicate check runs first; any hit blocks the
        // create, since a second company for a store the other rep already
        // has is the one mistake nothing local can catch.
        let companyId: string | null = null;
        if (writeEnabled("visit")) {
          const dupes = await findPossibleDuplicates(name, site);
          if (dupes.length > 0) {
            const names = dupes.slice(0, 3).map((d) => [d.name, d.city].filter(Boolean).join(", ")).join("; ");
            throw new Error(`${name} may already be in HubSpot (${names}). Nothing created. Pick it from the search instead.`);
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
        return resolveTouchpointToAccount(touchpointId, account.id, account.name);
      }
      const accountId = body?.accountId as string | undefined;
      const accountName = body?.accountName as string | undefined;
      if (!accountId || !accountName) throw new Error("accountId and accountName are required.");
      return resolveTouchpointToAccount(touchpointId, accountId, accountName);
    });
    if (!result.ok) {
      return Response.json({ ok: false, error: result.error }, { status: 422 });
    }
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not resolve that account." }, { status: 500 });
  }
}
