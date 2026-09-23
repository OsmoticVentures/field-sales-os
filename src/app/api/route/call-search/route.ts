/**
 * Live HubSpot search for AddStop's call field: contacts and companies in
 * one box, each with a phone when the portal has one. A read, so no
 * Idempotency-Key; the HubSpot token never leaves the server.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { searchHubspotForCall } from "../../../../lib/features/route/hubspot-call-search";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.trim().length < 2) return Response.json({ ok: true, results: [] });
  const results = await searchHubspotForCall(q);
  return Response.json({ ok: true, results });
}
