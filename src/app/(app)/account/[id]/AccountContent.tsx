/**
 * The client view body, shared by the full page and the slide-over that
 * opens on top of whatever screen I was on. The screen read in the car before walking in. Ported from
 * portfolio/src/app/nutribiotic/account/[id]/page.tsx and lib/account-detail.tsx.
 */
import { notFound } from "next/navigation";
import { PageHead } from "../../../../lib/core/ui";
import { getClientAccount, listClientActivities, listClientContacts } from "../../../../lib/features/clients/dal";
import { realChannel } from "../../../../lib/features/clients/ui";
import { getAccount, getPriorityBook, listAccountSdrQueue, listPurchases } from "../../../../lib/features/prospect/dal";
import { getRouteStateByDay, isConfigured as routeConfigured } from "../../../../lib/features/route/dal";
import { planningHorizonDates } from "../../../../lib/features/route/field-week";
import { AccountView } from "./AccountView";
import { TierButton } from "./TierButton";
import { dayLabel } from "../../../../lib/features/route/field-week";

export async function AccountContent({ id }: { id: string }) {
  const [account, contacts, activities, purchases, routeState, prospectAccount, book, sdrQueue] = await Promise.all([
    getClientAccount(id),
    listClientContacts(id),
    listClientActivities(id),
    listPurchases(id),
    routeConfigured() ? getRouteStateByDay() : Promise.resolve(null),
    getAccount(id).catch(() => null),
    getPriorityBook().catch(() => null),
    listAccountSdrQueue(id).catch(() => []),
  ]);
  if (!account) notFound();

  // The full planning horizon and every day's draft, not just today's: a
  // day-picker (AccountView's AddToRoute) needs to know which day, if any,
  // this account is already scheduled on, and offer every day to add it to,
  // not just whichever one happens to be "active" (2026-09-23, matching the
  // day-picker the source app's account profile got in commit aa9730c).
  const days = planningHorizonDates();
  const routeDraftByDay = routeState?.draft ?? {};

  const sub = [realChannel(account.channel), [account.street, account.city, account.postal].filter(Boolean).join(", ")]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <PageHead
        title={account.name}
        sub={sub || undefined}
        aside={
          <TierButton
            accountId={account.id}
            initialTier={
              account.potential_juan ??
              book?.byId.get(id)?.grade ??
              (account.potential_hq ? account.potential_hq.split(" ")[0] || null : null)
            }
            tierIsMine={Boolean(account.potential_juan)}
            score={book?.byId.get(id)?.score ?? null}
            warmth={prospectAccount?.readiness ?? null}
            leadStatus={prospectAccount?.lead_status ?? null}
            sdr={sdrQueue.map((e) => {
              const { weekday, short } = dayLabel(e.scheduled_date);
              return { kind: e.kind, date: e.scheduled_date, label: `${e.kind === "visit" ? "Visit" : "Call"} ${weekday} ${short}` };
            })}
          />
        }
      />
      <AccountView
        account={account}
        contacts={contacts}
        activities={activities}
        orders={purchases.orders}
        lines={purchases.lines}
        routeDays={days}
        routeDraftByDay={routeDraftByDay}
      />
    </>
  );
}

