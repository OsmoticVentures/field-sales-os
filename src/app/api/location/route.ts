/**
 * One location fix, from the route screen's own geolocation request or the
 * widget's "update" button. Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/api/location/route.ts). The auto-done
 * rule (a fix within a tenth of a mile of a stop) already runs where the DB
 * reads this row, per the brief; this endpoint only ever records the fix.
 */
import { setLastLocation } from "../../../lib/features/route/dal";
import { hasAccess } from "../../../lib/core/devices";
import { hasWidgetToken } from "../../../lib/features/route/widget-auth";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasWidgetToken(req)) && !(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  const { lat, lng } = (body ?? {}) as { lat?: unknown; lng?: unknown };
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return Response.json({ ok: false, error: "lat and lng must be numbers." }, { status: 400 });
  }

  try {
    await setLastLocation(lat, lng);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't save the location." }, { status: 500 });
  }
}
