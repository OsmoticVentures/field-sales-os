/**
 * The human gate on a drafted send. "sent" does NOT send anything: it only
 * records that Juan opened the compose window and, on his own word, sent it
 * himself, the OS cannot verify a send on any channel. "dismissed" just
 * closes the row out, no filing. Ported from the NutriBiotic OS's
 * outbound-actions.ts decideDraft.
 *
 * A sent draft files the exact body Juan drafted (never a re-summary) as an
 * activity and into HubSpot the same way a Visit tab touchpoint auto-files
 * (autoFileEngagement, touchpoint.ts). A filing failure never unwinds the
 * "sent" mark; the activity just stays unfiled.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { setDraftStatus } from "../../../../lib/features/outbound/dal";
import { insertActivity, getAccountNames } from "../../../../lib/features/visit/dal";
import { autoFileEngagement } from "../../../../lib/features/visit/touchpoint";

export const runtime = "nodejs";

type DecideBody = {
  id?: string;
  decision?: "sent" | "dismissed";
  accountId?: string | null;
  channel?: string;
  subject?: string | null;
  body?: string;
};

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: DecideBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (typeof body.id !== "string" || !body.id) {
    return Response.json({ ok: false, error: "id is required." }, { status: 400 });
  }
  if (body.decision !== "sent" && body.decision !== "dismissed") {
    return Response.json({ ok: false, error: 'decision must be "sent" or "dismissed".' }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`outbound:decide:${key}`, async () => {
      await setDraftStatus(body.id!, body.decision!);

      if (body.decision !== "sent") return null;
      if (!body.accountId || typeof body.body !== "string") {
        return { filed: false, accountName: null, hubspotFiled: false, hubspotNoteId: null, hubspotError: null };
      }

      const detail = body.channel === "email" ? `Emailed${body.subject ? ` "${body.subject}"` : ""}: ${body.body}` : body.body;
      const activity = await insertActivity({
        account_id: body.accountId,
        kind: "email_out",
        direction: "outbound",
        outcome: null,
        detail,
      });
      const hubspot = await autoFileEngagement(activity.id);
      const names = await getAccountNames([body.accountId]);
      return { filed: true, accountName: names[body.accountId] ?? null, ...hubspot };
    });
    return Response.json({ ok: true, result, replayed });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't save that." }, { status: 500 });
  }
}
