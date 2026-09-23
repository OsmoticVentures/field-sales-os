/**
 * Everything the Reports screen needs for one day: that day's draft, the
 * week it falls in, and each one's PDF link. The initial page render reads
 * the same lib/features/reports/dal.ts functions directly (a Server
 * Component doesn't need to fetch itself); this GET is what the client
 * component calls to refresh after a rebuild, a render, or a save, without a
 * full page reload. A read, no idempotency key needed.
 */
import { hasAccess } from "../../../lib/core/devices";
import {
  getReportDraft,
  reportPreviewHref,
  weekWindowFor,
  type ReportDraft,
} from "../../../lib/features/reports/dal";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const date = new URL(req.url).searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ ok: false, error: "A valid date is required." }, { status: 400 });
  }

  const week = weekWindowFor(date);
  const [daily, weekly] = await Promise.all([
    getReportDraft(date, "daily").catch((): ReportDraft | null => null),
    week ? getReportDraft(week.end, "weekly").catch((): ReportDraft | null => null) : Promise.resolve(null),
  ]);

  const dailyPreviewUrl =
    daily?.preview_path && !daily.dirty ? await reportPreviewHref(daily.preview_path) : null;
  const dailyArchivedUrl = await reportPreviewHref(`daily-${date}.pdf`);
  const weeklyPreviewUrl =
    weekly?.preview_path && !weekly.dirty ? await reportPreviewHref(weekly.preview_path) : null;
  const weeklyArchivedUrl = week ? await reportPreviewHref(`weekly-${week.start}_to_${week.end}.pdf`) : null;

  return Response.json({
    ok: true,
    daily,
    dailyPreviewUrl,
    dailyArchivedUrl,
    weekly,
    weeklyPreviewUrl,
    weeklyArchivedUrl,
    week,
  });
}
