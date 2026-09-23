/**
 * Where a day starts or ends, when it is not the default (home). Either
 * `start` or `end` (or both) may be sent; `null` clears that side's
 * override back to the default.
 */
import { getRouteEndpointsByDay, setRouteEndByDay, setRouteStartByDay } from "../../../../lib/features/route/dal";
import type { RouteEndpoint } from "../../../../lib/features/route/types";
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { day?: string; start?: RouteEndpoint | null; end?: RouteEndpoint | null };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (typeof body.day !== "string" || (body.start === undefined && body.end === undefined)) {
    return Response.json({ ok: false, error: "day and start or end are required." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`route:endpoints:${key}`, async () => {
      const current = await getRouteEndpointsByDay();
      const startByDay = { ...current.start };
      const endByDay = { ...current.end };
      if (body.start !== undefined) {
        if (body.start) startByDay[body.day!] = body.start;
        else delete startByDay[body.day!];
        await setRouteStartByDay(startByDay);
      }
      if (body.end !== undefined) {
        if (body.end) endByDay[body.day!] = body.end;
        else delete endByDay[body.day!];
        await setRouteEndByDay(endByDay);
      }
      return { start: startByDay, end: endByDay };
    });
    return Response.json({ ok: true, ...result, replayed });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't save that." }, { status: 500 });
  }
}
