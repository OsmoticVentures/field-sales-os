/**
 * My call on a dormant account's fit, from the client view: "Back on route"
 * or "Not a fit". One tap, reversible, stored as the override every later
 * fit pass keeps (setDormantFit). Never a HubSpot write.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { setDormantFit, type FitVerdict } from "../../../../lib/features/prospect/dal";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { account_id?: string; verdict?: FitVerdict };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (!body.account_id || (body.verdict !== "good_fit" && body.verdict !== "not_fit")) {
    return Response.json({ ok: false, error: "Missing account_id or verdict." }, { status: 400 });
  }
  try {
    const { result, replayed } = await withIdempotency(`account:fit:${key}`, () =>
      setDormantFit(body.account_id as string, body.verdict as FitVerdict),
    );
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    captureError(err, "/api/account/fit");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not save that." }, { status: 500 });
  }
}
