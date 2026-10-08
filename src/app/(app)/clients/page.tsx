/**
 * Clients: every account in Juan's book, ranked, with the pipeline over it.
 * Ported from portfolio/src/app/nutribiotic/clients/page.tsx. Default sort is
 * (OS tier, confidence), not fit, so a barely-measured account never tops
 * the list on one lucky input. Rows open the client view at /account/[id].
 */
import Link from "next/link";
import { requireAccess } from "../../../lib/core/devices";
import { myFlag } from "../../../lib/core/user";
import { Card, PageHead } from "../../../lib/core/ui";
import { getBookFacts, isConfigured, listClientAccounts, listClientAreas, listPipeline } from "../../../lib/features/clients/dal";
import { hoursStatus } from "../../../lib/features/prospect/hours";
import { ClientsList, type ClientsRow } from "./ClientsList";
import { TierChip, realLifecycle } from "../../../lib/features/clients/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Clients · ClientOS" };

const STAGES = ["identified", "contacted", "discovery", "sampled", "trial", "stocked", "reordered"];

const chip = (on: boolean) =>
  `inline-flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] transition-colors ${
    on ? "border-[#14201B] bg-[#14201B] text-[#F7F6F1]" : "border-[#E2DFD5] bg-white text-[#3D4A44] hover:bg-[#FAF9F5]"
  }`;

const eyebrow = "text-[12px] font-semibold uppercase tracking-[0.14em] text-[#8A928C]";

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ area?: string; sort?: string }> }) {
  await requireAccess();
  const sp = await searchParams;

  if (!isConfigured()) {
    return (
      <>
        <PageHead title="Clients" />
        <p className="text-[15px] text-[#5B6560]">No data source configured.</p>
      </>
    );
  }

  // The account list starts with the areas rather than after them; only an
  // area id that turns out not to exist costs a second read.
  const sort = "tier";
  const noAreas = await myFlag("no-area-filters");
  const askedArea = noAreas ? null : (sp.area ?? null);
  // One read of the book's per-account facts (hours, metrics, and the id set
  // the pipeline is filtered to) runs alongside the list, not after it.
  const facts = getBookFacts();
  const [areas, pipeline, askedRows, { metrics: metricsById, hours: hoursById }] = await Promise.all([
    noAreas ? Promise.resolve([]) : listClientAreas(),
    listPipeline(facts.then((f) => f.ids)),
    listClientAccounts({ area: askedArea, sort }),
    facts,
  ]);
  const area = areas.find((a) => a.id === askedArea) ?? null;
  const fetched = (area?.id ?? null) === askedArea ? askedRows : await listClientAccounts({ area: null, sort });
  // Tier first, then readiness inside each tier: urgent, hot, normal, cold, unset last.
  // Array.sort is stable, so the earlier order (best fit first) holds within a readiness.
  const READINESS_RANK: Record<string, number> = { urgent: 0, hot: 1, normal: 2, cold: 3, corporate: 4 };
  const rank = (id: string) => READINESS_RANK[metricsById[id]?.readiness ?? ""] ?? 5;
  // Ungraded accounts go to the very bottom, below every letter.
  const tierRank = (t: string | null) => (t ? t.charCodeAt(0) : 999);
  const rows = [...fetched].sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || rank(a.account_id) - rank(b.account_id));
  const listRows: ClientsRow[] = rows.map((r) => {
    const m = metricsById[r.account_id];
    const open = hoursStatus(hoursById[r.account_id]);
    return {
      id: r.account_id,
      name: r.name,
      lifecycle: realLifecycle(r.lifecycle),
      tier: r.tier,
      readiness: m?.readiness ?? null,
      shelf: m?.shelf_units ?? null,
      employees: m?.employee_count ?? null,
      stores: m?.stores_per_decision_maker ?? null,
      open: open ? { open: open.open, label: open.label } : null,
    };
  });

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

      {!noAreas && (
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
      )}

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
          </div>

          <ClientsList rows={listRows} />

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
