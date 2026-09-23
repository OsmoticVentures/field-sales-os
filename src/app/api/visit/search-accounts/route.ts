/**
 * Manual account search for the "not this guess, a different one" case in
 * AccountMatchResolver. This port's stand-in for the source's Google Places
 * search: it searches Juan's own book by name rather than the outside
 * world, see the port's handback for why.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { searchAccounts } from "../../../../lib/features/visit/dal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const q = new URL(req.url).searchParams.get("q") ?? "";
  const candidates = await searchAccounts(q);
  return Response.json({ ok: true, candidates }, { headers: { "cache-control": "no-store" } });
}
