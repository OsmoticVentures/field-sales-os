/**
 * Address/place lookup for a lunch, hotel or other stop, and for a start/end
 * override. Read-only, no row written, no Idempotency-Key needed (same
 * class as Expenses' classify route).
 */
import { resolveStopAddress, searchRouteAddresses } from "../../../../lib/shared/places";
import { hasAccess } from "../../../../lib/core/devices";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }

  let body: { query?: string; mode?: "resolve" | "search" };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  const query = typeof body.query === "string" ? body.query : "";

  if (body.mode === "search") {
    const results = await searchRouteAddresses(query);
    return Response.json({ ok: true, results });
  }

  const result = await resolveStopAddress(query);
  return Response.json(result);
}
