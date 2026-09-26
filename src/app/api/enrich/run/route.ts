/**
 * Find Contacts: one full pass (tiers 1-4) for one account, triggered by a
 * single tap on the Prospect call card. Idempotent because a dropped
 * connection mid-run (a real risk on four sequential network passes) must
 * not run the whole pipeline twice for the same tap; a replay returns the
 * exact result the first run already wrote.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { runFindContacts } from "../../../../lib/features/enrich/pipeline";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  const body = await req.json().catch(() => null);
  if (!body?.account_id) return Response.json({ ok: false, error: "Missing account_id." }, { status: 400 });

  try {
    const { result, replayed } = await withIdempotency(`enrich:run:${key}`, () => runFindContacts(body.account_id));
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Find Contacts failed." }, { status: 500 });
  }
}
