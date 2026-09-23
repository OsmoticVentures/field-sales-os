/**
 * Clients: every account in Juan's book, ranked, with the pipeline over it.
 * Ported from portfolio/src/app/nutribiotic/clients/page.tsx. Default sort is
 * (OS tier, confidence), not fit, so a barely-measured account never tops
 * the list on one lucky input. Rows open the client view at /account/[id].
 */
import Link from "next/link";
import { Card, PageHead } from "../../../lib/core/ui";
import {
  getAccountHoursMap,
  isConfigured,
  listClientAccounts,
  listClientAreas,
  listPipeline,
} from "../../../lib/features/clients/dal";
import { Confidence, OpenBadge, TierChip, realLifecycle } from "../../../lib/features/clients/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Clients · Field Sales OS" };

const STAGES = ["identified", "contacted", "discovery", "sampled", "trial", "stocked", "reordered"];

const chip = (on: boolean) =>
  `inline-flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] transition-colors ${
    on ? "border-[#14201B] bg-[#14201B] text-[#F7F6F1]" : "border-[#E2DFD5] bg-white text-[#3D4A44] hover:bg-[#FAF9F5]"
  }`;

const eyebrow = "text-[12px] font-semibold uppercase tracking-[0.14em] text-[#8A928C]";

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ area?: string; sort?: string }> }) {
  const sp = await searchParams;

  if (!isConfigured()) {
    return (
      <>
        <PageHead title="Clients" />
        <p className="text-[15px] text-[#5B6560]">No data source configured.</p>
      </>
    );
  }

  const [areas, pipeline] = await Promise.all([listClientAreas(), listPipeline()]);
  const area = areas.find((a) => a.id === sp.area) ?? null;
  const byEngagement = sp.sort === "engagement";
  const rows = await listClientAccounts({ area: area?.id ?? null, sort: byEngagement ? "engagement" : "tier" });
  const hoursById = await getAccountHoursMap(rows.map((r) => r.account_id));

  const byTier: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of rows) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;

  const byStage = new Map<string, typeof pipeline.deals>();
  for (const d of pipeline.deals) {
    if (!byStage.has(d.stage)) byStage.set(d.stage, []);
    byStage.get(d.stage)!.push(d);
  }
  const staleIds = new Set(pipeline.stale.map((s) => s.deal_id));
  const areaQuery = area ? `area=${area.id}` : "";

  return (
    <>
      <PageHead title="Clients" sub={area?.label} />

      <div className="mb-5 flex flex-wrap gap-1.5">
        <Link prefetch={false} href="/clients" className={chip(!area)}>
          All accounts
        </Link>
        {areas.map((a) => {
          const on = area?.id === a.id;
          return (
            <Link prefetch={false}
              key={a.id}
              href={`/clients?area=${a.id}`}
              className={chip(on)}
              style={on ? { background: a.color, borderColor: a.color } : undefined}
            >
              <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: on ? "#F7F6F1" : a.color }} />
              {a.label}
              {a.account_count != null && <span className={on ? "opacity-70" : "text-[#8A928C]"}>{a.account_count}</span>}
            </Link>
          );
        })}
      </div>

      {pipeline.deals.length > 0 && (
        <section className="mb-8">
          <h2 className={`mb-3 ${eyebrow}`}>Pipeline</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {STAGES.map((stage) => {
              const items = byStage.get(stage) ?? [];
              return (
                <Card key={stage}>
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="text-[13.5px] font-semibold capitalize">{stage}</div>
                    <div className="text-[12px] tabular-nums text-[#8A928C]">{items.length}</div>
                  </div>
                  <ul className="mt-3 flex flex-col gap-1">
                    {items.slice(0, 6).map((d) => (
                      <li key={d.id}>
                        <Link prefetch={false}
                          href={`/account/${d.account_id}`}
                          className="flex items-baseline justify-between gap-2 rounded px-1.5 py-1 text-[13px] transition-colors hover:bg-[#F4F2EA]"
                        >
                          <span className="min-w-0 flex-1 truncate">{d.next_step ?? "No next step"}</span>
                          {staleIds.has(d.id) && (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#A0762C]" aria-label="Flagged for weekly review" />
                          )}
                        </Link>
                      </li>
                    ))}
                    {items.length > 6 && <li className="px-1.5 pt-0.5 text-[11.5px] text-[#8A928C]">and {items.length - 6} more</li>}
                  </ul>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {rows.length === 0 ? (
        <Card className="text-[14px] text-[#5B6560]">No accounts in this area.</Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-[#5B6560]">
              <span>{rows.length} accounts</span>
              <span className="inline-flex items-center gap-2">
                <span className="text-[#8A928C]">OS tier</span>
                {(["A", "B", "C", "D"] as const).map((t) => (
                  <span key={t} className="inline-flex items-center gap-1.5">
                    <TierChip tier={t} />
                    {byTier[t] ?? 0}
                  </span>
                ))}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Link prefetch={false} href={`/clients${areaQuery ? `?${areaQuery}` : ""}`} className={chip(!byEngagement)}>
                OS tier
              </Link>
              <Link prefetch={false} href={`/clients?${[areaQuery, "sort=engagement"].filter(Boolean).join("&")}`} className={chip(byEngagement)}>
                Most engaged
              </Link>
            </div>
          </div>

          <ul className="divide-y divide-[#EDEBE3] overflow-hidden rounded-lg border border-[#E2DFD5] bg-white md:hidden">
            {rows.map((r) => (
              <li key={r.account_id}>
                <Link prefetch={false}
                  href={`/account/${r.account_id}`}
                  className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors active:bg-[#FAF9F5]"
                >
                  <TierChip tier={r.tier} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium">{r.name}</span>
                    <span className="mt-0.5 flex items-center gap-2 text-[12.5px] text-[#8A928C]">
                      <OpenBadge businessHours={hoursById[r.account_id]} dot />
                      {realLifecycle(r.lifecycle) && <span>{realLifecycle(r.lifecycle)}</span>}
                      {r.fit != null && <span className="tabular-nums">Fit {r.fit.toFixed(0)}</span>}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <div className="hidden overflow-hidden rounded-lg border border-[#E2DFD5] bg-white md:block">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="border-b border-[#E2DFD5] text-left text-[11px] uppercase tracking-[0.12em] text-[#8A928C]">
                  <th className="px-4 py-2.5 font-medium">OS tier</th>
                  <th className="px-4 py-2.5 font-medium">Account</th>
                  <th className="px-4 py-2.5 font-medium">Open</th>
                  <th className="px-4 py-2.5 font-medium">State</th>
                  <th className="px-4 py-2.5 text-right font-medium">Fit</th>
                  <th className="px-4 py-2.5 font-medium">Known</th>
                  <th className="px-4 py-2.5 text-right font-medium">Engagement</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#EDEBE3]">
                {rows.map((r) => {
                  const low = (r.fit_confidence ?? 0) < 0.5;
                  return (
                    <tr key={r.account_id} className="transition-colors hover:bg-[#FAF9F5]">
                      <td className="px-4 py-2.5">
                        <TierChip tier={r.tier} />
                      </td>
                      <td className="px-4 py-2.5">
                        <Link prefetch={false} href={`/account/${r.account_id}`} className="font-medium underline-offset-2 hover:underline">
                          {r.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">
                        <OpenBadge businessHours={hoursById[r.account_id]} dot />
                      </td>
                      <td className="px-4 py-2.5 text-[#5B6560]">{realLifecycle(r.lifecycle)}</td>
                      <td className={`px-4 py-2.5 text-right tabular-nums ${low ? "text-[#A79878]" : ""}`}>{r.fit?.toFixed(0) ?? "-"}</td>
                      <td className="px-4 py-2.5">
                        <Confidence value={r.fit_confidence} known={r.fit_inputs_known} total={r.fit_inputs_total} />
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-[#5B6560]">{r.engagement?.toFixed(0) ?? "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pipeline.deals.length > 0 && pipeline.stale.length > 0 && (
            <section className="mt-8">
              <h2 className={`mb-3 ${eyebrow}`}>Weekly review</h2>
              <ul className="divide-y divide-[#EDEBE3] overflow-hidden rounded-lg border border-[#E2DFD5] bg-white">
                {pipeline.stale.map((s) => (
                  <li key={s.deal_id}>
                    <Link prefetch={false}
                      href={`/account/${s.account_id}`}
                      className="flex min-h-11 items-center gap-3 px-4 py-2.5 text-[13.5px] transition-colors hover:bg-[#FAF9F5]"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">{s.account_name}</span>
                      <span className="w-[92px] shrink-0 text-[12px] text-[#8A928C]">{s.stage}</span>
                      <span className="shrink-0 text-[12px] text-[#A0762C]">
                        {s.next_step_days_overdue != null && s.next_step_days_overdue > 0
                          ? `${s.next_step_days_overdue}d since next step`
                          : s.days_since_activity != null
                            ? `${s.days_since_activity}d silent`
                            : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  );
}
