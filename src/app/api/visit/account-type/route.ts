/**
 * The type of a store New company just created, picked on the Visit screen
 * once its note has filed. Local only: the type is the OS's channel, which
 * HubSpot does not carry.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { STORE_TYPES, setAccountChannel, type StoreTypeValue } from "../../../../lib/features/visit/dal";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  const body = await req.json().catch(() => null);
  const accountId = body?.account_id as string | undefined;
  const channel = body?.channel as StoreTypeValue | undefined;
  if (!accountId) return Response.json({ ok: false, error: "account_id is required." }, { status: 400 });
  if (!channel || !STORE_TYPES.includes(channel)) return Response.json({ ok: false, error: "Bad store type." }, { status: 400 });

  try {
    const { result, replayed } = await withIdempotency(`visit:account-type:${key}`, async () => {
      await setAccountChannel(accountId, channel);
      return { channel };
    });
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not save that." }, { status: 500 });
  }
}
