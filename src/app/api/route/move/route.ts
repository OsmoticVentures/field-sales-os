/**
 * Move one stop to another day from any screen that shows it (the map card,
 * the account page, the account panel). Reads the saved route on the server,
 * takes the stop off whichever day holds it and appends it to the new day in
 * one write, so a stale screen can never drop or double a stop. A locked
 * time stays with the old day and does not follow the stop.
 */
import { getRouteStateByDay, setRouteDraft } from "../../../../lib/features/route/dal";
import { planningHorizonDates } from "../../../../lib/features/route/field-week";
import type { RouteDraftEntry } from "../../../../lib/features/route/types";
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";

const idOf = (e: RouteDraftEntry) => (typeof e === "string" ? e : e.id);

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { id?: unknown; day?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  const day = typeof body.day === "string" ? body.day : "";
  if (!id) return Response.json({ ok: false, error: "id is required." }, { status: 400 });
  if (!planningHorizonDates().includes(day)) {
    return Response.json({ ok: false, error: "Pick a day on the route." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`route:move:${key}`, async () => {
      const state = await getRouteStateByDay();
      let entry: RouteDraftEntry = id;
      let from: string | null = null;
      const next: Record<string, RouteDraftEntry[]> = {};
      for (const [d, entries] of Object.entries(state.draft)) {
        const hit = entries.find((e) => idOf(e) === id);
        if (hit !== undefined && d !== day) {
          entry = hit;
          from ??= d;
          next[d] = entries.filter((e) => idOf(e) !== id);
        } else {
          next[d] = entries;
        }
      }
      const target = next[day] ?? [];
      if (!target.some((e) => idOf(e) === id)) next[day] = [...target, entry];
      await setRouteDraft(next);
      return { from, day };
    });
    return Response.json({ ok: true, ...result, replayed });
  } catch (e) {
    captureError(e, "/api/route/move");
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't move the stop." }, { status: 500 });
  }
}
