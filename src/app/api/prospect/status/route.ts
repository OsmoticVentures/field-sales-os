/**
 * Mark a scheduled call or visit done or skipped. Never a hard delete: a
 * skipped call is a real fact about the day. This stands alone in this port
 * (no inline call-logging box, see PORTING.md's touchpoint-pipeline note),
 * the same "done by hand, no activity id" case the source app already
 * supports for a call made outside the capture box.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { setSdrScheduleStatus } from "../../../../lib/features/prospect/dal";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { id: string; status: "pending" | "done" | "skipped" };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (!body || !body.id || !["pending", "done", "skipped"].includes(body.status)) {
    return Response.json({ ok: false, error: "Missing id or status." }, { status: 400 });
  }
  try {
    const { result, replayed } = await withIdempotency(`prospect:status:${key}`, () => setSdrScheduleStatus(body.id, body.status));
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    captureError(err, "/api/prospect/status");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not save that." }, { status: 500 });
  }
}
