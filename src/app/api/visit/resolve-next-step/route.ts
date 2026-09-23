/**
 * Answers a touchpoint parked as needs_next_step: the account is already
 * known, this only needs the one line Juan types (or the explicit "no
 * follow-up needed").
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { resolveTouchpointNextStep } from "../../../../lib/features/visit/touchpoint";

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
  const touchpointId = body?.touchpointId as string | undefined;
  const nextStep = (body?.nextStep as string | undefined) ?? "";
  if (!touchpointId) {
    return Response.json({ ok: false, error: "touchpointId is required." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`visit:resolve-next-step:${key}`, () =>
      resolveTouchpointNextStep(touchpointId, nextStep),
    );
    if (!result.ok) {
      return Response.json({ ok: false, error: result.error }, { status: 422 });
    }
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not save that." }, { status: 500 });
  }
}
