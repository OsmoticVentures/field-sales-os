/**
 * Prospect: the scored call list. Ported from the NutriBiotic OS's
 * sdr/page.tsx (portfolio/src/app/nutribiotic/sdr/page.tsx). Same initial
 * server-side load (schedule, account call cards, the priority book,
 * territory areas), handed to a client component that does its own writes
 * through /api/prospect/* route handlers rather than Server Actions
 * (PORTING.md).
 *
 * Scope, per this port's feature inventory (m1): the deck's "business scout"
 * that writes an opening angle for a brand-new, never-contacted business is
 * deck-only, not built anywhere in the source app. What is real, and what
 * this screen shows, is the Angle panel for an account already in the book
 * (current state / future state / impact), plus the headhunter's own
 * contacts (read-only here, the headhunter itself stays on the Mac
 * unchanged), opening hours, and the ranked opportunity list.
 */
import { PageHead } from "../../../lib/core/ui";
import { ProspectClient } from "./ProspectClient";
import { getAccountCallCards, getPriorityBook, isConfigured, listAreas, listSdrSchedule, todayStartLA } from "../../../lib/features/prospect/dal";
import { sortAreasByProspects } from "../../../lib/features/prospect/priority";

export const dynamic = "force-dynamic";

export const metadata = { title: "Prospect · Field Sales OS" };

const DAYS_AHEAD = 6;

export default async function ProspectPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const focusAccountId = (await searchParams).account?.trim() || null;

  if (!isConfigured()) {
    return (
      <>
        <PageHead title="Prospect" />
        <p className="text-[15px] text-[#5B6560]">No data source configured.</p>
      </>
    );
  }

  const schedule = await listSdrSchedule(DAYS_AHEAD);
  const accountIds = [
    ...new Set([...schedule.map((r) => r.account_id).filter((id): id is string => !!id), ...(focusAccountId ? [focusAccountId] : [])]),
  ];
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

  const todayIso = todayStartLA().slice(0, 10);
  const orderedAreas = sortAreasByProspects(areas, priority.areaProspects).map((a) => ({
    id: a.id,
    label: a.label,
    color: a.color,
    prospects: priority.areaProspects.get(a.id) ?? 0,
  }));

  const topRanked = priority.ranked.slice(0, 12).map((r) => ({
    id: r.account.id,
    name: r.account.name,
    area: r.account.area ?? null,
    score: r.result.score,
    reason: r.result.reason,
    band: r.result.band,
  }));

  return (
    <>
      <PageHead title="Prospect" />
      <ProspectClient
        initialItems={items}
        todayIso={todayIso}
        days={DAYS_AHEAD}
        areas={orderedAreas}
        focusAccountId={focusAccountId}
        focusAccountName={focusAccountId ? (cards[focusAccountId]?.name ?? null) : null}
        focusAccountPhone={focusAccountId ? (cards[focusAccountId]?.phone ?? null) : null}
        topRanked={topRanked}
      />
    </>
  );
}
