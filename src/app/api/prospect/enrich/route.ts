/**
 * The Angle panel's "Enrich further" button: a roughly 30-second look at the
 * website, Google Places, and this account's own order history right before
 * a call. See lib/features/prospect/quick-enrich.ts for the pass itself.
 * Idempotent because a retry (a dropped connection mid-call) must not run
 * the model twice or double-apply a hours/summary write.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { enrichAccountQuickly } from "../../../../lib/features/prospect/quick-enrich";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  const body = await req.json();
  if (!body.account_id) return Response.json({ ok: false, error: "Missing account_id." }, { status: 400 });

  const { result, replayed } = await withIdempotency(`prospect:enrich:${key}`, () => enrichAccountQuickly(body.account_id));
  return Response.json({ ok: true, result, replayed });
}
