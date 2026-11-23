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
import { withdrawUnfiledVisit } from "../../../../lib/features/visit/dal";
import { invalidatePriorityBook } from "../../../../lib/features/prospect/dal";
import { AI_CAP_STATUS, isAiCap } from "../../../../lib/core/ai/client";
import { acceptNote, type DoorRead } from "../../../../lib/features/visit/waiting";
import { currentUser, DEFAULT_USER } from "../../../../lib/core/user";
import { looksLikeTestFiling, TEST_FILING_ERROR } from "../../../../lib/features/visit/test-filing";

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
  // When he wrote it on the phone, which a note waiting for the laptop can be
  // long before it files. HubSpot and the account history carry this time.
  const written = Date.parse(String(body?.occurredAt ?? ""));
  const occurredAt = written <= Date.now() + 5 * 60_000 && written >= Date.now() - 30 * 864e5 ? new Date(written).toISOString() : null;
  const replaces = body?.replaces as { touchpointId?: string; activityId?: number } | undefined;

  // JUAN'S NOTES: saved here in this one request, no model and no laptop, and
  // the phone item clears on this answer (Juan, 2026-11-23). The Mac reads it
  // on the Max plan from this copy and files it (waiting.ts, note_reader.py);
  // HubSpot is its own scheduled step after that (hubspot_sweep.py). A pick
  // sent back with a parse is the other rep's flow and still files here.
  const me = await currentUser().catch(() => null);
  if (me?.id === DEFAULT_USER && !parsed) {
    if (looksLikeTestFiling(text)) return Response.json({ ok: false, error: TEST_FILING_ERROR }, { status: 400 });
    try {
      const n = body?.near as { lat?: unknown; lng?: unknown } | undefined;
      const near = typeof n?.lat === "number" && typeof n?.lng === "number" ? { lat: n.lat, lng: n.lng } : null;
      const doorRead: DoorRead | null =
        body?.grade || body?.readiness || body?.counts
          ? { grade: body?.grade ?? null, readiness: body?.readiness ?? null, counts: body?.counts ?? null }
          : null;
      const result = await acceptNote({
        key,
        rep: me.id,
        text,
        accountIdHint,
        kindOverride: kindOverride ?? null,
        forceNewAccount,
        occurredAt: occurredAt ?? new Date().toISOString(),
        doorRead,
        near,
        replaces: replaces?.touchpointId && Number.isInteger(replaces.activityId) ? replaces : null,
      });
      return Response.json({ ok: true, result, replayed: false });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not save that note." }, { status: 503 });
    }
  }

  try {
    // A failure is thrown, not returned, so it is never stored under the key:
    // the one-tap retry with the same key runs again instead of replaying it.
    // "Not sure which store" writes nothing and is not stored either, so the
    // same note logged again after an edit is read fresh.
    const { result, replayed } = await withIdempotency(`visit:touchpoint:${key}`, async () => {
      const r = await recordTouchpoint(text, accountIdHint, { kindOverride, forceNewAccount, parsed, occurredAt });
      if (!r.ok) throw new NotFiled(r.error);
      if (r.needsAccount) throw new NotSure(r);
      return r;
    });
    // An edited visit replaces the refused one, after the new one is in.
    const old = replaces?.touchpointId && Number.isInteger(replaces.activityId) ? replaces : null;
    const filed = result as { touchpoint_id?: string };
    if (old && filed.touchpoint_id && filed.touchpoint_id !== old.touchpointId) {
      await withdrawUnfiledVisit(old.touchpointId!, old.activityId!).catch(() => false);
    }
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
