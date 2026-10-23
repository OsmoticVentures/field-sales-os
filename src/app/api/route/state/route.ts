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
  listLoggedStopIds,
  listOwnerAccounts,
  setRouteDone,
} from "../../../../lib/features/route/dal";
import { planningHorizonDates, defaultActiveDay, laTodayIso } from "../../../../lib/features/route/field-week";
import { listPendingDrafts, type Draft } from "../../../../lib/features/outbound/dal";
import { hasAccess } from "../../../../lib/core/devices";
import { captureError } from "@/lib/core/errors";

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
        version: "",
        logged: {},
        emails: {},
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

    // A visit or meeting logged today for one of today's stops marks it
    // done, kept with the rest of the day's done marks so every reader of
    // the route (the widget, the ETAs) sees the same day. Its pending
    // Outbound draft rides along for the stop's Open email button.
    const today = laTodayIso();
    const todayIds = (state.draft[today] ?? []).filter((e): e is string => typeof e === "string");
    const logged = await listLoggedStopIds(todayIds, today).catch(() => [] as string[]);
    const doneToday = state.done[today] ?? [];
    const newlyDone = logged.filter((id) => !doneToday.includes(id));
    if (newlyDone.length > 0) {
      state.done = { ...state.done, [today]: [...doneToday, ...newlyDone] };
      await setRouteDone(state.done).catch((e) => captureError(e, "/api/route/state auto-done"));
    }
    const emails: Record<string, Draft> = {};
    if (logged.length > 0) {
      const drafts = await listPendingDrafts().catch(() => [] as Draft[]);
      for (const d of drafts) {
        if (d.account_id && logged.includes(d.account_id) && !emails[d.account_id] && d.channel === "email") emails[d.account_id] = d;
      }
    }

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
        version: state.version,
        logged: { [today]: logged },
        emails,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    captureError(e, "/api/route/state");
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't load the route." }, { status: 500 });
  }
}
