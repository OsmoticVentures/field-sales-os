/**
 * The route screen's one combined read: the planning horizon, Juan's owned
 * book, the schedule prefs, the hand-built draft/calls/done/stop-times, and
 * the start/end overrides by day. Ported in spirit from the NutriBiotic OS's
 * api/route-state/route.ts and map/page.tsx, combined into one GET so a
 * phone on a field connection makes one round trip, not five.
 */
import {
  getHomeEndpoint,
  getRouteEndpointsByDay,
  getRouteSchedulePrefs,
  getRouteStateByDay,
  isConfigured,
  listOwnerAccounts,
} from "../../../../lib/features/route/dal";
import { planningHorizonDates, defaultActiveDay } from "../../../../lib/features/route/field-week";
import { hasAccess } from "../../../../lib/core/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }

  const days = planningHorizonDates();

  if (!isConfigured()) {
    return Response.json(
      {
        ok: true,
        days,
        activeDay: days[0],
        home: null,
        prefs: { depart: "09:30", dwellMinutes: 20, lunchMinutes: 30 },
        accounts: [],
        startByDay: {},
        endByDay: {},
        draft: {},
        calls: {},
        done: {},
        times: {},
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const [accounts, home, prefs, state, endpoints] = await Promise.all([
      listOwnerAccounts(),
      getHomeEndpoint(),
      getRouteSchedulePrefs(),
      getRouteStateByDay(),
      getRouteEndpointsByDay(),
    ]);

    return Response.json(
      {
        ok: true,
        days,
        activeDay: defaultActiveDay(state.draft, days),
        home,
        prefs,
        accounts,
        startByDay: endpoints.start,
        endByDay: endpoints.end,
        draft: state.draft,
        calls: state.calls,
        done: state.done,
        times: state.times,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't load the route." }, { status: 500 });
  }
}
