/**
 * The client view: the screen read in the car before walking in. Ported from
 * portfolio/src/app/nutribiotic/account/[id]/page.tsx and lib/account-detail.tsx.
 */
import { notFound } from "next/navigation";
import { PageHead } from "../../../../lib/core/ui";
import { getClientAccount, listClientActivities, listClientContacts } from "../../../../lib/features/clients/dal";
import { realChannel } from "../../../../lib/features/clients/ui";
import { listPurchases } from "../../../../lib/features/prospect/dal";
import { getRouteStateByDay, isConfigured as routeConfigured } from "../../../../lib/features/route/dal";
import { planningHorizonDates } from "../../../../lib/features/route/field-week";
import { AccountView } from "./AccountView";

export const dynamic = "force-dynamic";

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [account, contacts, activities, purchases, routeState] = await Promise.all([
    getClientAccount(id),
    listClientContacts(id),
    listClientActivities(id),
    listPurchases(id),
    routeConfigured() ? getRouteStateByDay() : Promise.resolve(null),
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
      <PageHead title={account.name} sub={sub || undefined} />
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

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const account = await getClientAccount((await params).id).catch(() => null);
  return { title: `${account?.name ?? "Client"} · Field Sales OS` };
}
