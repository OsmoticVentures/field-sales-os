/**
 * The Visit screen's door for a store the note named that is not in the book
 * yet. The flow itself (Places enrichment, portal-wide duplicate check,
 * company, account) is lib/features/visit/new-account.ts, shared with the
 * Mac's door. Returns the new account and the store type Places suggests;
 * the Visit screen files the note to it, then asks the type.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { AlreadyInHubspot, createAccountForNote } from "../../../../lib/features/visit/new-account";
import type { LatLng } from "../../../../lib/shared/places";
import { captureError } from "@/lib/core/errors";

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
  const name = (body?.name as string | undefined)?.trim();
  if (!name) {
    return Response.json({ ok: false, error: "A business name is required." }, { status: 400 });
  }
  const city = (body?.city as string | undefined) || null;
  const n = body?.near as { lat?: unknown; lng?: unknown } | undefined;
  const near: LatLng | null =
    typeof n?.lat === "number" && typeof n?.lng === "number" && Number.isFinite(n.lat) && Number.isFinite(n.lng) ? { lat: n.lat, lng: n.lng } : null;
  // Search picked one exact Places result: use it as is, no re-guessing.
  const place = body?.place as Record<string, unknown> | undefined;

  try {
    const { result, replayed } = await withIdempotency(`visit:new-account:${key}`, () =>
      createAccountForNote({ name, city, near, place }),
    );
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    // Another rep's company: the phone holds the note in red with the reason
    // instead of retrying it.
    if (err instanceof AlreadyInHubspot) return Response.json({ ok: false, error: err.message }, { status: 409 });
    captureError(err, "/api/visit/new-account");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not create that account." }, { status: 500 });
  }
}
