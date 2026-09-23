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
import { defaultActiveDay, planningHorizonDates } from "../../../../lib/features/route/field-week";
import type { RouteDraftEntry } from "../../../../lib/features/route/types";
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

  const days = planningHorizonDates();
  const routeDay = routeState ? defaultActiveDay(routeState.draft, days) : null;
  const routeEntries: RouteDraftEntry[] = routeState && routeDay ? (routeState.draft[routeDay] ?? []) : [];

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
        routeDay={routeDay}
        routeEntries={routeEntries}
      />
    </>
  );
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const account = await getClientAccount((await params).id).catch(() => null);
  return { title: `${account?.name ?? "Client"} · Field Sales OS` };
}
