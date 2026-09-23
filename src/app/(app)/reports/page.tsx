/**
 * Reports. The all-time field metrics, and the daily and weekly report
 * built for one day, with its published PDF. Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/reports/page.tsx). The generators
 * themselves (bridges/nutribiotic/field_report.py, weekly_report.py) stay on
 * the Mac unchanged; this screen only lists and serves what they produced.
 *
 * LEFT OUT, DECK ONLY (research/feature-inventory.md, m1): cross-rep
 * benchmarking and market intelligence. Every metric below is scoped to
 * Juan's own owner id, the only book this app has, so there is nothing to
 * compare against and nothing shown in that shape.
 *
 * ALSO LEFT OUT OF THIS PORT, not deck-only, just not this feature's files:
 * the book-standing tiles (active clients, book prospects, orders placed)
 * and the sales-collateral pipeline the old Reports tab also carried. Both
 * read from parts of the old dal.ts this port's scope doesn't own; see the
 * handback for where they'd live.
 */
import { PageHead, Card, eyebrowCls } from "../../../lib/core/ui";
import {
  getAllTimeMetrics,
  getReportDraft,
  listPlaybookReportArchive,
  listPlaybookReports,
  reportDateLA,
  reportPreviewHref,
  weekWindowFor,
} from "../../../lib/features/reports/dal";
import { ReportsClient } from "./ReportsClient";

export const dynamic = "force-dynamic";

export const metadata = { title: "Reports · Field Sales OS" };

type NumericMetricKey = "visits" | "touchpoints" | "miles" | "daysWorked" | "newAccounts" | "accountsClosed";
const METRIC_TILES: Array<{ key: NumericMetricKey; label: string; fmt?: (n: number) => string }> = [
  { key: "visits", label: "Visits made" },
  { key: "touchpoints", label: "Total touchpoints" },
  { key: "miles", label: "Total miles", fmt: (n) => n.toLocaleString() },
  { key: "daysWorked", label: "Days worked" },
  { key: "newAccounts", label: "New accounts opened" },
  { key: "accountsClosed", label: "Accounts confirmed closed" },
];

const REPORT_TITLE: Record<"daily" | "weekly", string> = {
  daily: "Daily field report",
  weekly: "Weekly field report",
};

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const today = reportDateLA();
  const sp = await searchParams;
  const selectedDate = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) && sp.date <= today ? sp.date : today;
  const week = weekWindowFor(selectedDate);

  const [allTime, daily, weekly, reports, archive] = await Promise.all([
    getAllTimeMetrics(),
    getReportDraft(selectedDate, "daily"),
    week ? getReportDraft(week.end, "weekly") : Promise.resolve(null),
    listPlaybookReports(),
    listPlaybookReportArchive(),
  ]);

  const dailyPreviewUrl = daily?.preview_path && !daily.dirty ? await reportPreviewHref(daily.preview_path) : null;
  const dailyArchivedUrl = await reportPreviewHref(`daily-${selectedDate}.pdf`);
  const weeklyPreviewUrl = weekly?.preview_path && !weekly.dirty ? await reportPreviewHref(weekly.preview_path) : null;
  const weeklyArchivedUrl = week ? await reportPreviewHref(`weekly-${week.start}_to_${week.end}.pdf`) : null;

  return (
    <>
      <PageHead title="Reports" />

      {allTime && (
        <section className="mb-7">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <div className={eyebrowCls}>All time</div>
            {allTime.throughDate && <div className="text-[11px] text-[#8A928C]">through {allTime.throughDate}</div>}
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {METRIC_TILES.map((t) => (
              <Card key={t.key} className="p-3.5 text-center">
                <div className="text-[22px] leading-none font-semibold tracking-tight tabular-nums">
                  {(t.fmt ?? String)(allTime[t.key])}
                </div>
                <div className="mt-1.5 text-[11px] leading-snug text-[#5B6560]">{t.label}</div>
              </Card>
            ))}
          </div>
        </section>
      )}

      <ReportsClient
        today={today}
        initialDate={selectedDate}
        initialWeek={week}
        initialDaily={daily}
        initialDailyPreviewUrl={dailyPreviewUrl}
        initialDailyArchivedUrl={dailyArchivedUrl}
        initialWeekly={weekly}
        initialWeeklyPreviewUrl={weeklyPreviewUrl}
        initialWeeklyArchivedUrl={weeklyArchivedUrl}
      />

      <section className="mb-7">
        <div className="grid gap-3.5 md:grid-cols-2">
          {(["daily", "weekly"] as const).map((kind) => {
            const report = reports.find((r) => r.kind === kind);
            return (
              <Card key={kind} className="flex h-full flex-col gap-1.5">
                <span className="text-[16.5px] font-semibold tracking-tight">{REPORT_TITLE[kind]}</span>
                {report ? (
                  <>
                    <p className="text-[13px] leading-relaxed text-[#5B6560]">{report.label}</p>
                    <a
                      href={report.url}
                      className="mt-1 text-[13px] font-medium text-[#2C6A46] underline decoration-[#2C6A46]/40 underline-offset-2 hover:decoration-[#2C6A46]"
                    >
                      Open PDF
                    </a>
                  </>
                ) : (
                  <p className="text-[13px] leading-relaxed text-[#8A928C]">Nothing published yet.</p>
                )}
              </Card>
            );
          })}
        </div>
        {archive.reports.length > 0 ? (
          <details className="mt-3">
            <summary className="cursor-pointer text-[11.5px] text-[#8A928C]">
              Archive ({archive.reports.length} earlier report{archive.reports.length === 1 ? "" : "s"})
            </summary>
            <div className="mt-2 grid gap-3.5 md:grid-cols-2">
              {(["daily", "weekly"] as const).map((kind) => {
                const items = archive.reports.filter((r) => r.kind === kind);
                const hidden = archive.truncated[kind];
                if (!items.length && !hidden) return null;
                return (
                  <div key={kind}>
                    <ul className="space-y-1">
                      {items.map((r) => (
                        <li key={r.url} className="flex items-baseline justify-between gap-3 text-[13px]">
                          <span className="text-[#5B6560]">{r.label}</span>
                          <a
                            href={r.url}
                            className="shrink-0 font-medium text-[#2C6A46] underline decoration-[#2C6A46]/40 underline-offset-2 hover:decoration-[#2C6A46]"
                          >
                            Open PDF
                          </a>
                        </li>
                      ))}
                    </ul>
                    {hidden ? <p className="mt-1 text-[12px] text-[#8A928C]">{hidden} more not shown</p> : null}
                  </div>
                );
              })}
            </div>
          </details>
        ) : (
          <p className="mt-3 text-[11.5px] text-[#8A928C]">No archived reports yet.</p>
        )}
      </section>
    </>
  );
}
