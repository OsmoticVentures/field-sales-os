/**
 * Answers a touchpoint parked as needs_account: either a pick from Juan's
 * own book, or a bare new account (this port's stand-in for the source's
 * Google-Places-driven createBusinessFromPlace, see PORTING.md and the
 * port's handback).
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { insertBareAccount } from "../../../../lib/features/visit/dal";
import { resolveTouchpointToAccount } from "../../../../lib/features/visit/touchpoint";

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
  if (!touchpointId) {
    return Response.json({ ok: false, error: "touchpointId is required." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`visit:resolve-account:${key}`, async () => {
      if (body?.mode === "create") {
        const name = (body?.name as string | undefined)?.trim();
        if (!name) throw new Error("A business name is required.");
        const account = await insertBareAccount({ name, city: (body?.city as string | undefined) || null });
        return resolveTouchpointToAccount(touchpointId, account.id, account.name);
      }
      const accountId = body?.accountId as string | undefined;
      const accountName = body?.accountName as string | undefined;
      if (!accountId || !accountName) throw new Error("accountId and accountName are required.");
      return resolveTouchpointToAccount(touchpointId, accountId, accountName);
    });
    if (!result.ok) {
      return Response.json({ ok: false, error: result.error }, { status: 422 });
    }
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not resolve that account." }, { status: 500 });
  }
}
