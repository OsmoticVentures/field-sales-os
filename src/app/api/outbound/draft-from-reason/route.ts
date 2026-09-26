/**
 * Route's Suggested returns "Generate outbound": compose a pitch from a
 * reason Juan typed on the spot, rather than the account's own Gap Selling
 * summary. Ported from the NutriBiotic OS's account-actions.ts
 * draftAccountPitchFromReason (commit 09843d7/map/RoutePanel.tsx). Same
 * grounding gate as /api/outbound/draft, just a different source text.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { draftAccountPitchFromReason } from "../../../../lib/features/outbound/actions";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { account_id?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (typeof body.account_id !== "string" || !body.account_id) {
    return Response.json({ ok: false, error: "account_id is required." }, { status: 400 });
  }
  if (typeof body.reason !== "string" || !body.reason.trim()) {
    return Response.json({ ok: false, error: "reason is required." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`outbound:draft-reason:${key}`, () =>
      draftAccountPitchFromReason(body.account_id!, body.reason!),
    );
    return Response.json({ ok: true, result, replayed });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Could not draft that." }, { status: 500 });
  }
}
