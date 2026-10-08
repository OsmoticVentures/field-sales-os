/**
 * Name + region lookup for one business that is not in the book. Read-only,
 * Google Places, California only. Each result says whether it is already an
 * account (same Places id), so the card opens it instead of adding a twin.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { searchPlaces } from "../../../../lib/shared/places";
import { findAccountIdsByPlaceIds } from "../../../../lib/features/visit/dal";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const q = typeof body?.query === "string" ? body.query.trim() : "";
  if (q.length < 3) return Response.json({ ok: true, results: [] });

  try {
    const found = (await searchPlaces(q, 4)).filter((c) => !(c.businessStatus ?? "").startsWith("CLOSED"));
    const owned = await findAccountIdsByPlaceIds(found.map((c) => c.placeId));
    return Response.json({
      ok: true,
      results: found.map((c) => ({ ...c, accountId: owned.get(c.placeId) ?? null })),
    });
  } catch (caught) {
    captureError(caught, "/api/search/place");
    return Response.json({ ok: false, error: "Could not look that up." }, { status: 502 });
  }
}
