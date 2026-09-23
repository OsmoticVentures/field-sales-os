/**
 * Move a scheduled call or visit to another day. Writes
 * nb_sdr_schedule.scheduled_date and stamps rescheduled_at, the field the
 * Mac-side follow-through pass reads to know a human already answered for
 * this account.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { rescheduleSdrScheduleItem } from "../../../../lib/features/prospect/dal";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  const body = await req.json();
  if (!body.id || !body.scheduled_date) return Response.json({ ok: false, error: "Missing id or date." }, { status: 400 });
  try {
    const { result, replayed } = await withIdempotency(`prospect:reschedule:${key}`, () => rescheduleSdrScheduleItem(body.id, body.scheduled_date));
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not move that." }, { status: 500 });
  }
}
