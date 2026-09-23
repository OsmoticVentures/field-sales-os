/**
 * The one typed-note door: extract, then file or park. Ported from
 * portfolio/src/app/nutribiotic/api/touchpoint/route.ts and lib/touchpoint.ts's
 * recordTouchpoint, converted from a Server Action to a route handler per
 * PORTING.md (no Server Actions in this repo).
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { recordTouchpoint } from "../../../../lib/features/visit/touchpoint";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const key = idempotencyKey(req);
  if (!key) {
    return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const text = (body?.text as string | undefined)?.trim();
  if (!text) {
    return Response.json({ ok: false, error: "Nothing to record." }, { status: 400 });
  }
  const accountIdHint = (body?.accountIdHint as string | undefined) || null;
  const kindOverride = body?.kindOverride as "meeting" | "call" | "email" | "field_note" | undefined;
  const forceNewAccount = Boolean(body?.forceNewAccount);

  try {
    const { result, replayed } = await withIdempotency(`visit:touchpoint:${key}`, () =>
      recordTouchpoint(text, accountIdHint, { kindOverride, forceNewAccount }),
    );
    if (!result.ok) {
      return Response.json({ ok: false, error: result.error }, { status: 422 });
    }
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "That note did not file." }, { status: 500 });
  }
}
