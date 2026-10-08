/**
 * The one typed-note door: extract, then file. A note whose store is not
 * named with confidence comes back asking which account, with its parse, and
 * files when the Visit screen sends that parse back with the pick. Nothing is
 * parked for later. Ported from
 * portfolio/src/app/nutribiotic/api/touchpoint/route.ts and lib/touchpoint.ts's
 * recordTouchpoint, converted from a Server Action to a route handler per
 * PORTING.md (no Server Actions in this repo).
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { recordTouchpoint, type ParsedTouchpoint } from "../../../../lib/features/visit/touchpoint";
import { invalidatePriorityBook } from "../../../../lib/features/prospect/dal";
import { AI_CAP_STATUS, isAiCap } from "../../../../lib/core/ai/client";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  // A new touch moves the priority score; the next read recomputes it.
  invalidatePriorityBook();

  const key = idempotencyKey(req);
  if (!key) {
    return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const text = (body?.text as string | undefined)?.trim();
  if (!text) {
    return Response.json({ ok: false, error: "Nothing to record." }, { status: 400 });
  }
  const accountIdHint = (body?.accountIdHint as string | undefined) || null;
  const kindOverride = body?.kindOverride as "meeting" | "call" | "email" | "field_note" | undefined;
  const forceNewAccount = Boolean(body?.forceNewAccount);
  const parsed = (body?.parsed as ParsedTouchpoint | undefined) ?? null;

  try {
    // A failure is thrown, not returned, so it is never stored under the key:
    // the one-tap retry with the same key runs again instead of replaying it.
    // "Not sure which store" writes nothing and is not stored either, so the
    // same note logged again after an edit is read fresh.
    const { result, replayed } = await withIdempotency(`visit:touchpoint:${key}`, async () => {
      const r = await recordTouchpoint(text, accountIdHint, { kindOverride, forceNewAccount, parsed });
      if (!r.ok) throw new NotFiled(r.error);
      if (r.needsAccount) throw new NotSure(r);
      return r;
    });
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    if (err instanceof NotSure) return Response.json({ ok: true, result: err.result, replayed: false });
    if (isAiCap(err)) return Response.json({ ok: false, error: err.message }, { status: AI_CAP_STATUS });
    const status = err instanceof NotFiled ? 422 : 500;
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "That note did not file." }, { status });
  }
}

class NotFiled extends Error {}
class NotSure extends Error {
  constructor(readonly result: unknown) {
    super("Not sure which store.");
  }
}
