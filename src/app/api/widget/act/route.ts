/**
 * The widget's two writes: cross a stop off, and put an account in the SDR
 * call queue. Widget bearer or a signed-in session, same as the widget read.
 *
 * Both are idempotent by shape (a set-add and a check for the same account
 * already queued for that date), so a double tap or a replay changes nothing.
 * Scope stays Juan's book: insertSdrScheduleItem refuses any account he does
 * not own.
 */
import { getRouteStateByDay, setRouteDone, setRouteMileageDay } from "../../../../lib/features/route/dal";
import { insertSdrScheduleItem, listSdrSchedule, type SdrPriority } from "../../../../lib/features/prospect/dal";
import { laTodayIso, planningHorizonDates } from "../../../../lib/features/route/field-week";
import { hasAccess } from "../../../../lib/core/devices";
import { hasWidgetToken } from "../../../../lib/features/route/widget-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIORITIES = new Set<SdrPriority>(["low", "mid", "high"]);

export async function POST(req: Request) {
  if (!(await hasWidgetToken(req)) && !(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  let body: { action?: string; day?: string; id?: string; priority?: string; kind?: string };
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

    if (body.action === "sdr") {
      const priority = PRIORITIES.has(body.priority as SdrPriority) ? (body.priority as SdrPriority) : "mid";
      // The next field day after today: a call list is worked ahead, not
      // from a phone at the curb.
      const today = laTodayIso();
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
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't save that." }, { status: 500 });
  }
}
