/**
 * Businesses Juan X'd out of Search. GET returns every hidden Places id so the
 * results list can drop them; POST hides one more for good. An upsert on the
 * Places id, so a replay changes nothing and it takes no idempotency key.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { hidePlace, listHiddenPlaceIds } from "../../../../lib/features/search/dal";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  try {
    return Response.json({ ok: true, ids: await listHiddenPlaceIds() });
  } catch (caught) {
    captureError(caught, "/api/search/hidden");
    return Response.json({ ok: false, error: "Could not read hidden businesses." }, { status: 502 });
  }
}

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  let body: { places_id?: unknown; name?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected a JSON body." }, { status: 400 });
  }
  const id = typeof body.places_id === "string" ? body.places_id.trim().slice(0, 200) : "";
  if (!id) return Response.json({ ok: false, error: "Missing business id." }, { status: 400 });
  try {
    await hidePlace(id, typeof body.name === "string" ? body.name : null);
    return Response.json({ ok: true });
  } catch (caught) {
    captureError(caught, "/api/search/hidden");
    return Response.json({ ok: false, error: "Could not hide that business." }, { status: 502 });
  }
}
