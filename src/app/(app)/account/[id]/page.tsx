/**
 * The client view as a full page: what loads on a direct visit or refresh.
 * From inside the app it opens as a slide-over instead (@modal), so the
 * screen underneath stays mounted.
 */
import { getClientAccount } from "../../../../lib/features/clients/dal";
import { requireAccess } from "../../../../lib/core/devices";
import { AccountContent } from "./AccountContent";

export const dynamic = "force-dynamic";

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAccess();
  return <AccountContent id={(await params).id} />;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const account = await getClientAccount((await params).id).catch(() => null);
  return { title: `${account?.name ?? "Client"} · Field Sales OS` };
}
