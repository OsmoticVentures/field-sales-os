/**
 * The two facts the Angle panel edits inline, right where a rep is about to
 * dial: the phone number, and Juan's own A-E potential grade. A number heard
 * or read wrong is corrected on the account itself, the same "fix the
 * record" rule the source app's account-actions.ts uses, never left as a
 * note beside a stale value.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { setAccountPhone, setAccountPotentialJuan } from "../../../../lib/features/prospect/dal";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  const body = await req.json();
  if (!body.account_id || (body.field !== "phone" && body.field !== "potential_juan")) {
    return Response.json({ ok: false, error: "Missing account_id or field." }, { status: 400 });
  }
  try {
    const { result, replayed } = await withIdempotency(`prospect:fact:${key}`, async () => {
      if (body.field === "phone") await setAccountPhone(body.account_id, body.value);
      else await setAccountPotentialJuan(body.account_id, body.value || null);
      return { field: body.field, value: body.value };
    });
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not save that." }, { status: 500 });
  }
}
