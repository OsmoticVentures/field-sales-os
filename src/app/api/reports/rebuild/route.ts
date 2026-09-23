/**
 * Ask the Mac for a fresh build of a day's report. Ported from the
 * NutriBiotic OS's report-actions.ts (actionRequestRebuild), as a route
 * handler with an idempotency guard per PORTING.md, since this app runs no
 * Server Actions.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { requestReportRebuild } from "../../../../lib/features/reports/dal";

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) {
    return Response.json({ ok: false, error: "Idempotency-Key is required." }, { status: 400 });
  }
  let date: string;
  try {
    const body = (await req.json()) as { date?: string };
    date = body.date ?? "";
  } catch {
    return Response.json({ ok: false, error: "Expected a JSON body." }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ ok: false, error: "A valid date is required." }, { status: 400 });
  }
  try {
    const { replayed } = await withIdempotency(`reports-rebuild:${key}`, () => requestReportRebuild(date));
    return Response.json({ ok: true, replayed });
  } catch {
    return Response.json({ ok: false, error: "Could not ask for a rebuild." }, { status: 500 });
  }
}
