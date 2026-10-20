import { saveRouteSchedulePrefs } from "../../../../lib/features/route/dal";
import type { RouteSchedulePrefs } from "../../../../lib/features/route/types";
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let prefs: RouteSchedulePrefs;
  try {
    prefs = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (typeof prefs.depart !== "string" || typeof prefs.dwellMinutes !== "number" || typeof prefs.lunchMinutes !== "number") {
    return Response.json({ ok: false, error: "depart, dwellMinutes and lunchMinutes are required." }, { status: 400 });
  }

  // Same limits as the ui_prefs_route_minutes_sane check in the database; a
  // cleared box reads as 0 and would otherwise fail the PATCH with a 500.
  const whole = (n: number, min: number) => Number.isInteger(n) && n >= min && n <= 240;
  if (!whole(prefs.dwellMinutes, 1) || !whole(prefs.lunchMinutes, 0)) {
    return Response.json({ ok: false, error: "Minutes per stop must be 1 to 240 and lunch 0 to 240." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`route:prefs:${key}`, async () => {
      await saveRouteSchedulePrefs(prefs);
      return prefs;
    });
    return Response.json({ ok: true, prefs: result, replayed });
  } catch (e) {
    captureError(e, "/api/route/prefs");
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't save that." }, { status: 500 });
  }
}
