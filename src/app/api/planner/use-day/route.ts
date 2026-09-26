/**
 * "Use this day": writes one day of Plan week's proposal onto Juan's live
 * route draft. Route handler + Idempotency-Key per PORTING.md; a retry (a
 * flaky connection at a stop, a doubled tap) never re-resolves a directive
 * or duplicates a day's stops.
 */
import { useDay } from "../../../../lib/features/planner/use-day";
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { date?: string; accountIds?: string[]; directiveIds?: string[]; mode?: "replace" | "add" };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (typeof body.date !== "string" || !Array.isArray(body.accountIds)) {
    return Response.json({ ok: false, error: "date and accountIds are required." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`planner:use-day:${key}`, () =>
      useDay({
        date: body.date!,
        accountIds: body.accountIds!.filter((id): id is string => typeof id === "string"),
        directiveIds: Array.isArray(body.directiveIds) ? body.directiveIds.filter((id): id is string => typeof id === "string") : [],
        mode: body.mode === "replace" || body.mode === "add" ? body.mode : undefined,
      }),
    );

    if (result.status === "conflict") {
      return Response.json({ ok: true, conflict: true, existingCount: result.existingCount });
    }
    if (result.status === "error") {
      return Response.json({ ok: false, error: result.error }, { status: 400 });
    }
    return Response.json({ ok: true, draft: result.draft, replayed });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't use that day." }, { status: 500 });
  }
}
