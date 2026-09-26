/**
 * Plan week's one read: a proposed drivable week over the planning horizon.
 * Read-only (no writes, no Idempotency-Key needed), so a phone can refresh
 * it as often as it likes without risk.
 */
import { proposeWeek } from "../../../../lib/features/planner/propose";
import { hasAccess } from "../../../../lib/core/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }

  const url = new URL(req.url);
  const daysParam = url.searchParams.get("days");
  const days = daysParam ? Number(daysParam) : undefined;

  try {
    const result = await proposeWeek(days);
    if (result.status === "blocked") {
      return Response.json({ ok: true, status: "blocked", reason: result.reason, week: null }, { headers: { "cache-control": "no-store" } });
    }
    return Response.json({ ok: true, status: "ok", week: result.week }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't build a plan." }, { status: 500 });
  }
}
