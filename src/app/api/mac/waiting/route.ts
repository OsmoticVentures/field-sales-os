/**
 * The Mac files a phone note that waited for the laptop (nb_waiting_notes,
 * waiting.ts). bridges/nutribiotic/note_reader.py claims the row, reads the
 * note on the Max plan against api/mac/extract-spec, and posts the parse here
 * with the row's key. The text and hints come from the row, never the caller.
 *
 * Filed under `visit:touchpoint:<key>`, the phone's own idempotency key, so the
 * phone's next retry is replayed this answer and the note files once. HubSpot
 * files exactly as from the phone. A note whose store is not clear writes
 * nothing and is left to the phone, which asks him which account.
 *
 * POST { key, mac_parsed } -> { ok, result: { status, touchpoint_id? } }
 */
import { macAuthorized } from "../../../../lib/core/mac-auth";
import { withIdempotency } from "../../../../lib/core/idempotency";
import { recordTouchpoint } from "../../../../lib/features/visit/touchpoint";
import { getWaiting, settleWaiting } from "../../../../lib/features/visit/waiting";
import { invalidatePriorityBook } from "../../../../lib/features/prospect/dal";
import { isAiCap } from "../../../../lib/core/ai/client";

export const runtime = "nodejs";
export const maxDuration = 60;

class NotFiled extends Error {}
class NotSure extends Error {}

export async function POST(req: Request) {
  if (!macAuthorized(req)) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });

  const body = await req.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key : "";
  if (!key || body?.mac_parsed === undefined) {
    return Response.json({ ok: false, error: "key and mac_parsed are required." }, { status: 400 });
  }
  const note = await getWaiting(key);
  // Withdrawn on the phone (discarded or taken back to edit) since the claim.
  if (!note) return Response.json({ ok: true, result: { status: "withdrawn" } });

  invalidatePriorityBook();
  try {
    const { result } = await withIdempotency(`visit:touchpoint:${key}`, async () => {
      const r = await recordTouchpoint(note.text, note.account_id_hint, {
        kindOverride: note.kind_override ?? undefined,
        forceNewAccount: note.force_new_account,
        occurredAt: note.occurred_at,
        macParsed: body.mac_parsed,
        tryMac: false,
      });
      if (!r.ok) throw new NotFiled(r.error);
      if (r.needsAccount) throw new NotSure();
      return r;
    });
    const touchpointId = (result as { touchpoint_id?: string }).touchpoint_id ?? null;
    await settleWaiting(key, "filed", { touchpoint_id: touchpointId, error: null });
    return Response.json({ ok: true, result: { status: "filed", touchpoint_id: touchpointId } });
  } catch (err) {
    if (err instanceof NotSure) {
      await settleWaiting(key, "needs_account");
      return Response.json({ ok: true, result: { status: "needs_account" } });
    }
    const msg = err instanceof Error ? err.message : String(err);
    // The AI cap or a passing miss: back to waiting, the next claim tries again.
    await settleWaiting(key, isAiCap(err) ? "waiting" : "failed", { error: msg.slice(0, 500) });
    return Response.json({ ok: false, error: msg }, { status: err instanceof NotFiled ? 422 : 500 });
  }
}
