/**
 * Append accounts to one day's route from outside the Route screen (Search's
 * Add to Route). Reads the day's saved order and appends only the ids not on
 * it yet, so a replay or a second tap never doubles a stop. Optimize on the
 * Route screen puts them in drive order.
 */
import { getRouteStateByDay, setRouteDraft } from "../../../../lib/features/route/dal";
import { planningHorizonDates } from "../../../../lib/features/route/field-week";
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";

/** One Search selection, at most. */
const MAX_IDS = 25;

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { day?: unknown; ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  const day = typeof body.day === "string" ? body.day : "";
  if (!planningHorizonDates().includes(day)) {
    return Response.json({ ok: false, error: "Pick a day on the route." }, { status: 400 });
  }
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((x): x is string => typeof x === "string" && x.length > 0))] : [];
  if (ids.length === 0 || ids.length > MAX_IDS) {
    return Response.json({ ok: false, error: `Pick between 1 and ${MAX_IDS} places.` }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`route:add:${key}`, async () => {
      const state = await getRouteStateByDay();
      const entries = state.draft[day] ?? [];
      const onDay = new Set(entries.map((e) => (typeof e === "string" ? e : e.id)));
      const fresh = ids.filter((id) => !onDay.has(id));
      if (fresh.length > 0) await setRouteDraft({ ...state.draft, [day]: [...entries, ...fresh] });
      return { added: fresh.length, already: ids.length - fresh.length, stops: entries.length + fresh.length };
    });
    return Response.json({ ok: true, ...result, replayed });
  } catch (e) {
    captureError(e, "/api/route/add");
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't add them to the route." }, { status: 500 });
  }
}
