/**
 * Save one day's hand-built stop order. Route handler + Idempotency-Key per
 * PORTING.md; this is an upsert of one day's array, so a replay is naturally
 * safe, but the same key still guards against a doubled network retry.
 */
import { getRouteStateByDay, setRouteDraft } from "../../../../lib/features/route/dal";
import type { RouteDraftEntry } from "../../../../lib/features/route/types";
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { day?: string; entries?: RouteDraftEntry[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (typeof body.day !== "string" || !Array.isArray(body.entries)) {
    return Response.json({ ok: false, error: "day and entries are required." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`route:draft:${key}`, async () => {
      const state = await getRouteStateByDay();
      const next = { ...state.draft, [body.day!]: body.entries! };
      await setRouteDraft(next);
      return next;
    });
    return Response.json({ ok: true, draft: result, replayed });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't save the stop." }, { status: 500 });
  }
}
