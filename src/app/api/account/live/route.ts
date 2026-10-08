/**
 * The parts of the client view that move by the minute and so never live in
 * the phone store: the route draft by day (which day this client is on, and
 * what Add to route appends to) and the client's open SDR entries. Without
 * `id`, just the route draft (the phone uses today's stops to fetch any
 * client outside the book). Small: one prefs row and at most five SDR rows.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { readAccountLive } from "../../../../lib/features/clients/account-payload";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  try {
    const live = await readAccountLive(id || null);
    return Response.json({ ok: true, ...live }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    captureError(err, "/api/account/live");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not read the route." }, { status: 500 });
  }
}
