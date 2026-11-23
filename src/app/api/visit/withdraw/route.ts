/**
 * A note discarded on the phone, or taken back to edit, is withdrawn from the
 * server's waiting copy (waiting.ts) so the Mac never files it. Only a note
 * still waiting is removed; one already filed is left as filed.
 *
 * POST { id } -> { ok }
 */
import { hasAccess } from "../../../../lib/core/devices";
import { withdrawWaiting } from "../../../../lib/features/visit/waiting";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return Response.json({ ok: false, error: "id is required." }, { status: 400 });
  await withdrawWaiting(id);
  return Response.json({ ok: true, result: null });
}
