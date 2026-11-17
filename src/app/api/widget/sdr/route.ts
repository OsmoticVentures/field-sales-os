/**
 * The SDR call list, as one JSON snapshot the "SDR Calls" home-screen widget
 * renders. A mirror of the Prospect screen's queue for the working day, never
 * a second source: the rows are nb_sdr_schedule, the lines are the same
 * call-context helpers the Prospect card prints.
 *
 * Metered reads (root AGENTS.md P9): no priority book here. That book is
 * about 515 KB and a widget refreshes all day on cold servers, so the order
 * is the row's own priority, then the order it was queued. One run is a
 * handful of narrow reads for at most five accounts.
 */
import { getAccountCallCards, getCallContexts, getSdrTally, isConfigured, listSdrSchedule } from "../../../../lib/features/prospect/dal";
import { buyingLine, callReason } from "../../../../lib/features/prospect/call-context";
import { workingDayIso } from "../../../../lib/features/route/field-week";
import { hasAccess } from "../../../../lib/core/devices";
import { hasWidgetToken } from "../../../../lib/features/route/widget-auth";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The day's call target: a small fixed number, so a day can be finished. */
const TARGET = 5;
const RANK: Record<string, number> = { high: 3, mid: 2, low: 1 };

function origin(): string {
  return process.env.NB_PUBLIC_ORIGIN ?? "";
}

export async function GET(request: Request) {
  if (!(await hasWidgetToken(request)) && !(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  if (!isConfigured()) {
    return Response.json({ ok: false, error: "No data source configured." }, { status: 500 });
  }

  const asked = new URL(request.url).searchParams.get("day");
  let day = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : workingDayIso();

  try {
    const schedule = await listSdrSchedule(6);
    /* A day with nothing left to dial shows the next day that has calls, so
       the widget is never empty while a queue is waiting. */
    const open = (d: string) => schedule.some((r) => r.kind === "call" && r.status === "pending" && r.scheduled_date === d);
    if (!asked && !open(day)) {
      const next = schedule.find((r) => r.kind === "call" && r.status === "pending" && r.scheduled_date > day);
      if (next) day = next.scheduled_date;
    }
    const tally = await getSdrTally(day);
    const pending = schedule
      .filter((r) => r.kind === "call" && r.status === "pending" && r.scheduled_date === day)
      .sort((a, b) => (RANK[b.priority ?? ""] ?? 0) - (RANK[a.priority ?? ""] ?? 0) || a.created_at.localeCompare(b.created_at));
    const shown = pending.slice(0, TARGET);
    const ids = [...new Set(shown.map((r) => r.account_id).filter((v): v is string => Boolean(v)))];
    const [cards, contexts] = await Promise.all([getAccountCallCards(ids), getCallContexts(ids)]);

    const calls = shown.map((r) => {
      const card = r.account_id ? cards[r.account_id] : undefined;
      const ctx = r.account_id ? contexts[r.account_id] : undefined;
      const phone = card?.phone ?? r.prospect_phone ?? null;
      const reason = callReason(r.notes, ctx?.lastOrderAt ?? null);
      const buying = ctx ? buyingLine(ctx) : null;
      return {
        id: r.id,
        name: card?.name ?? r.prospect_name ?? null,
        ...(r.account_id ? { account_id: r.account_id } : {}),
        ...(r.priority ? { priority: r.priority } : {}),
        ...(phone ? { phone, tel_url: `tel:${phone.replace(/[^\d+]/g, "")}` } : {}),
        ...(reason ? { reason } : {}),
        ...(buying ? { buying } : {}),
        ...(r.account_id ? { account_url: `${origin()}/nb/prospect?account=${r.account_id}` } : {}),
      };
    }).filter((c) => c.name);

    const todayLA = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
    const heading =
      day === todayLA
        ? "Today"
        : new Date(`${day}T12:00:00Z`).getTime() - new Date(`${todayLA}T12:00:00Z`).getTime() === 86_400_000
          ? "Tomorrow"
          : new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

    return Response.json({
      ok: true,
      day,
      heading,
      generated_at: new Date().toISOString(),
      target: TARGET,
      done: tally.callsToday,
      reached_today: tally.reachedToday,
      reached_week: tally.reachedWeek,
      remaining: pending.length,
      calls,
      prospect_url: `${origin()}/nb/prospect`,
    });
  } catch (e) {
    captureError(e, "/api/widget/sdr");
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't load the calls." }, { status: 500 });
  }
}
