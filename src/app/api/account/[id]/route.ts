/**
 * One client's view data, fresh: what the phone fetches when a client is not
 * in its store yet, and right after the app changes that client (a tier, a
 * note) so the store and the screen agree. Same assembly as the snapshot,
 * see lib/features/clients/account-payload.ts.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { readAccountPayload } from "../../../../lib/features/clients/account-payload";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const { id } = await params;
  try {
    const payload = await readAccountPayload(id);
    if (!payload) return Response.json({ ok: false, error: "No such client." }, { status: 404, headers: { "Cache-Control": "no-store" } });
    return Response.json({ ok: true, payload }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    captureError(err, "/api/account/[id]");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not read that client." }, { status: 500 });
  }
}
