import { getRouteStateByDay, setRouteStopTimes } from "../../../../lib/features/route/dal";
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { day?: string; times?: Record<string, string> };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (typeof body.day !== "string" || typeof body.times !== "object" || body.times === null) {
    return Response.json({ ok: false, error: "day and times are required." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`route:times:${key}`, async () => {
      const state = await getRouteStateByDay();
      const next = { ...state.times, [body.day!]: body.times! };
      await setRouteStopTimes(next);
      return next;
    });
    return Response.json({ ok: true, times: result, replayed });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't save that time." }, { status: 500 });
  }
}
