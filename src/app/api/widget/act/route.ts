/**
 * The widgets' writes: cross a stop off, put an account in the SDR call
 * queue, and file one call's result from the SDR Calls widget. Widget bearer or a signed-in session, same as the widget read.
 *
 * Both are idempotent by shape (a set-add and a check for the same account
 * already queued for that date), so a double tap or a replay changes nothing.
 * Scope stays Juan's book: insertSdrScheduleItem refuses any account he does
 * not own.
 */
import { getRouteStateByDay, setRouteDone, setRouteMileageDay } from "../../../../lib/features/route/dal";
import {
  claimPendingSdrRow,
  getSdrScheduleItem,
  insertSdrScheduleItem,
  isInMyBook,
  listSdrSchedule,
  restoreSdrRow,
  setSdrScheduleStatus,
  type SdrPriority,
} from "../../../../lib/features/prospect/dal";
import { insertActivity } from "../../../../lib/features/visit/dal";
import { autoFileEngagement } from "../../../../lib/features/visit/touchpoint";
import { workingDayIso, planningHorizonDates, nextWeekday } from "../../../../lib/features/route/field-week";
import { hasAccess } from "../../../../lib/core/devices";
import { hasWidgetToken } from "../../../../lib/features/route/widget-auth";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIORITIES = new Set<SdrPriority>(["low", "mid", "high"]);

/** The SDR Calls widget's result buttons, and what each one files. The
 *  outcome values are the ones nb_activities already carries for calls. */
const RESULTS: Record<string, { outcome: string; detail: string; moveTo?: "tomorrow" | "next_week" }> = {
  reached: { outcome: "reached", detail: "Call: reached." },
  no_answer: { outcome: "no_answer", detail: "Call: no answer." },
  no_decision_maker: { outcome: "no_decision_maker", detail: "Call: no decision maker available." },
  declined: { outcome: "declined", detail: "Call: declined." },
  call_back_tomorrow: { outcome: "reschedule", detail: "Call: asked to call back", moveTo: "tomorrow" },
  call_back_next_week: { outcome: "reschedule", detail: "Call: asked to call back", moveTo: "next_week" },
};

function weekdayName(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * One call's result, from the home screen. The row is claimed first with a
 * conditional write (still pending, still on the date the widget showed), so
 * a double tap files once. Then the activity goes through the same
 * insertActivity + autoFileEngagement path a logged call takes in the app, so
 * HubSpot gets it exactly as it would from there.
 */
async function callResult(id: string, result: string): Promise<Response> {
  const spec = RESULTS[result];
  if (!spec) return Response.json({ ok: false, error: "Unknown result." }, { status: 400 });
  const row = await getSdrScheduleItem(id);
  if (!row || row.kind !== "call") return Response.json({ ok: false, error: "That call is not in the queue." }, { status: 404 });
  if (!row.account_id) return Response.json({ ok: false, error: "That call has no account to file it on." }, { status: 400 });
  if (!(await isInMyBook(row.account_id))) {
    return Response.json({ ok: false, error: "That account is not in your book, nothing was filed." }, { status: 403 });
  }
  if (row.status !== "pending") return Response.json({ ok: true, already: true });

  let movedTo: string | null = null;
  if (spec.moveTo) {
    const today = workingDayIso();
    movedTo = spec.moveTo === "tomorrow" ? (planningHorizonDates(3).find((d) => d > today) ?? today) : nextWeekday(1);
    if (movedTo <= today) movedTo = planningHorizonDates(9).find((d) => d > today && new Date(`${d}T12:00:00Z`).getUTCDay() === 1) ?? movedTo;
    const claimed = await claimPendingSdrRow(id, row.scheduled_date, { scheduled_date: movedTo, rescheduled_at: new Date().toISOString() });
    if (!claimed) return Response.json({ ok: true, already: true });
  } else {
    const claimed = await claimPendingSdrRow(id, row.scheduled_date, { status: "done" });
    if (!claimed) return Response.json({ ok: true, already: true });
  }

  let activityId: number;
  try {
    const activity = await insertActivity({
      account_id: row.account_id,
      kind: "call",
      direction: "outbound",
      outcome: spec.outcome,
      detail: movedTo ? `${spec.detail} ${weekdayName(movedTo)}.` : spec.detail,
    });
    activityId = activity.id;
  } catch (e) {
    // Nothing was filed: put the row back so the call is still on the list.
    await restoreSdrRow(id, { status: "pending", scheduled_date: row.scheduled_date, rescheduled_at: row.rescheduled_at }).catch(() => {});
    throw e;
  }
  if (!movedTo) await setSdrScheduleStatus(id, "done", activityId);
  const hubspot = await autoFileEngagement(activityId);
  return Response.json({ ok: true, outcome: spec.outcome, moved_to: movedTo, activity_id: activityId, ...hubspot });
}

export async function POST(req: Request) {
  if (!(await hasWidgetToken(req)) && !(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  let body: { action?: string; day?: string; id?: string; priority?: string; kind?: string; result?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (body.action !== "odo" && (typeof body.id !== "string" || !body.id)) {
    return Response.json({ ok: false, error: "id is required." }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";

  try {
    if (body.action === "done") {
      if (typeof body.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)) {
        return Response.json({ ok: false, error: "day must be YYYY-MM-DD." }, { status: 400 });
      }
      const state = await getRouteStateByDay();
      const current = state.done[body.day] ?? [];
      if (!current.includes(id)) {
        await setRouteDone({ ...state.done, [body.day]: [...current, id] });
      }
      return Response.json({ ok: true });
    }

    if (body.action === "odo") {
      // The photo stays on the phone (filed weekly in Expenses). This only
      // records that the side was handled, so the day never asks twice.
      const kind = body.kind === "end" ? "end" : "start";
      if (typeof body.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)) {
        return Response.json({ ok: false, error: "day must be YYYY-MM-DD." }, { status: 400 });
      }
      await setRouteMileageDay(body.day, {
        [kind]: { odo: null, driveFileId: "", photoLink: "", capturedAt: new Date().toISOString(), manual: true },
      });
      return Response.json({ ok: true });
    }

    if (body.action === "call_result") {
      return await callResult(id, typeof body.result === "string" ? body.result : "");
    }

    if (body.action === "sdr") {
      const priority = PRIORITIES.has(body.priority as SdrPriority) ? (body.priority as SdrPriority) : "mid";
      // The next field day after today: a call list is worked ahead, not
      // from a phone at the curb.
      const today = workingDayIso();
      const scheduled = planningHorizonDates(3).find((d) => d > today) ?? today;
      const existing = await listSdrSchedule(6);
      const dupe = existing.find((r) => r.account_id === body.id && r.scheduled_date === scheduled && r.status === "pending");
      if (!dupe) {
        await insertSdrScheduleItem({ account_id: body.id, kind: "call", scheduled_date: scheduled, priority });
      }
      return Response.json({ ok: true, scheduled_date: scheduled, priority });
    }

    return Response.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (e) {
    captureError(e, "/api/widget/act");
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't save that." }, { status: 500 });
  }
}
