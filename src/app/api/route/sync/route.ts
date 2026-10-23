/**
 * Keeps two devices on the same route. The route screen calls this on
 * resume, on focus, and every 30 seconds while it is open, with the version
 * it last saw. Nothing moved: a few bytes back. Moved: the route itself
 * (draft, calls, done, stop times, start/end), never the account book,
 * which /api/route/state carries. Read-only.
 */
import { getRouteEndpointsByDay, getRouteStateByDay, getRouteVersion, isConfigured } from "../../../../lib/features/route/dal";
import { hasAccess } from "../../../../lib/core/devices";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  if (!isConfigured()) return Response.json({ ok: true, same: true, version: "" }, { headers: { "cache-control": "no-store" } });

  const seen = new URL(req.url).searchParams.get("v") ?? "";
  try {
    const version = await getRouteVersion();
    if (seen && version === seen) {
      return Response.json({ ok: true, same: true, version }, { headers: { "cache-control": "no-store" } });
    }
    const [state, endpoints] = await Promise.all([getRouteStateByDay(), getRouteEndpointsByDay()]);
    return Response.json(
      {
        ok: true,
        same: false,
        version: state.version,
        draft: state.draft,
        calls: state.calls,
        done: state.done,
        times: state.times,
        calendar: state.calendar,
        startByDay: endpoints.start,
        endByDay: endpoints.end,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    captureError(e, "/api/route/sync");
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't read the route." }, { status: 500 });
  }
}
