import { getRouteStateByDay, setRouteDone } from "../../../../lib/features/route/dal";
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { day?: string; done?: string[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (typeof body.day !== "string" || !Array.isArray(body.done)) {
    return Response.json({ ok: false, error: "day and done are required." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`route:done:${key}`, async () => {
      const state = await getRouteStateByDay();
      const next = { ...state.done, [body.day!]: body.done! };
      await setRouteDone(next);
      return next;
    });
    return Response.json({ ok: true, done: result, replayed });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't save that." }, { status: 500 });
  }
}
