/**
 * Re-render the preview PDF from whatever payload is already stored, no
 * HubSpot pull. Ported from report-actions.ts's actionRenderPreview, as a
 * route handler with an idempotency guard per PORTING.md.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { requestPreviewRender } from "../../../../lib/features/reports/dal";

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) {
    return Response.json({ ok: false, error: "Idempotency-Key is required." }, { status: 400 });
  }
  let date: string;
  let kind: "daily" | "weekly";
  try {
    const body = (await req.json()) as { date?: string; kind?: string };
    date = body.date ?? "";
    kind = body.kind === "weekly" ? "weekly" : "daily";
  } catch {
    return Response.json({ ok: false, error: "Expected a JSON body." }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ ok: false, error: "A valid date is required." }, { status: 400 });
  }
  try {
    const { replayed } = await withIdempotency(`reports-render:${key}`, () => requestPreviewRender(date, kind));
    return Response.json({ ok: true, replayed });
  } catch {
    return Response.json({ ok: false, error: "Could not start the render." }, { status: 500 });
  }
}
