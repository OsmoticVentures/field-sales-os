/**
 * The account profile's "Draft outreach" tap: compose a pitch from the
 * account's own Gap Selling summary. Ported from the NutriBiotic OS's
 * account-actions.ts draftAccountPitch (commit aa9730c), as a route handler
 * per PORTING.md rather than a Server Action.
 *
 * This calls the Anthropic API (ANTHROPIC_API_KEY) through compose.ts's
 * composeAsk and writes one nb_outbound_drafts row, so it needs an
 * Idempotency-Key like every other write route, even though the row it
 * writes can be the "not written" form.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { draftAccountPitch } from "../../../../lib/features/outbound/actions";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { account_id?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (typeof body.account_id !== "string" || !body.account_id) {
    return Response.json({ ok: false, error: "account_id is required." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`outbound:draft:${key}`, () => draftAccountPitch(body.account_id!));
    return Response.json({ ok: true, result, replayed });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Could not draft that." }, { status: 500 });
  }
}
