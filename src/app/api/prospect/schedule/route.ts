/**
 * The call list itself: the days ahead, each row's account card and
 * priority score already merged in. Ported from the NutriBiotic OS's
 * sdr/page.tsx server load (portfolio/src/app/nutribiotic/sdr/page.tsx) as
 * a route handler, since this app's writes are route handlers, not Server
 * Actions (PORTING.md); the initial page load itself still runs server-side
 * in page.tsx for the fastest first paint, this route serves the client's
 * own refetch after an add/status/reschedule write.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { getAccountCallCards, getPriorityBook, insertSdrScheduleItem, isConfigured, listAreas, listSdrSchedule, todayStartLA } from "../../../../lib/features/prospect/dal";
import { sortAreasByProspects } from "../../../../lib/features/prospect/priority";

export const runtime = "nodejs";

const DAYS_AHEAD = 6;

export async function GET() {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  if (!isConfigured()) return Response.json({ ok: true, items: [], areas: [], todayIso: todayStartLA().slice(0, 10) });

  const schedule = await listSdrSchedule(DAYS_AHEAD);
  const accountIds = [...new Set(schedule.map((r) => r.account_id).filter((id): id is string => !!id))];
  const [cards, priority, areas] = await Promise.all([getAccountCallCards(accountIds), getPriorityBook(), listAreas()]);

  const items = schedule.map((r) => {
    const card = r.account_id ? cards[r.account_id] : undefined;
    const p = r.account_id ? priority.byId.get(r.account_id) : undefined;
    return {
      ...r,
      displayName: card?.name ?? r.prospect_name ?? "Unnamed",
      displayPhone: card?.phone ?? r.prospect_phone ?? null,
      area: card?.area ?? null,
      businessHours: card?.businessHours ?? null,
      priorityScore: p?.score ?? null,
      priorityReason: p?.reason ?? null,
      priorityBand: p?.band ?? null,
    };
  });

  const orderedAreas = sortAreasByProspects(areas, priority.areaProspects).map((a) => ({
    id: a.id,
    label: a.label,
    color: a.color,
    prospects: priority.areaProspects.get(a.id) ?? 0,
  }));

  return Response.json({
    ok: true,
    items,
    areas: orderedAreas,
    todayIso: todayStartLA().slice(0, 10),
    topRanked: priority.ranked.slice(0, 12).map((r) => ({ id: r.account.id, name: r.account.name, area: r.account.area, score: r.result.score, reason: r.result.reason, band: r.result.band })),
  });
}

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  const body = await req.json();
  try {
    const { result, replayed } = await withIdempotency(`prospect:add:${key}`, () =>
      insertSdrScheduleItem({
        account_id: body.account_id ?? null,
        prospect_name: body.prospect_name ?? null,
        prospect_phone: body.prospect_phone ?? null,
        kind: body.kind ?? "call",
        scheduled_date: body.scheduled_date,
        notes: body.notes ?? null,
        priority: body.priority ?? null,
      }),
    );
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not add that call." }, { status: 500 });
  }
}
