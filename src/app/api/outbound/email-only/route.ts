/**
 * Route's "Email only" tap on a stop: find the angle and file one draft on
 * Outbound, never Outlook Drafts (email-only.ts). Calls the model, writes
 * one nb_outbound_drafts row, so it takes an Idempotency-Key like every
 * other write route.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { draftEmailOnly } from "../../../../lib/features/outbound/email-only";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
// Up to two compose attempts, each on the laptop (up to two minutes) or the key.
export const maxDuration = 300;

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
    const { result, replayed } = await withIdempotency(`outbound:email-only:${key}`, () => draftEmailOnly(body.account_id!));
    return Response.json({ ok: true, result, replayed });
  } catch (e) {
    captureError(e, "/api/outbound/email-only");
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Could not draft that." }, { status: 500 });
  }
}
