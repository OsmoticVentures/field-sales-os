/**
 * A client opened from inside the app: a side panel with the screen pushed
 * aside. The panel's View account opens the full client view over it. The
 * screen underneath stays mounted, so closing lands on it untouched (tab,
 * scroll, filters, map, typing).
 *
 * Static: no access check and no reads here. The view paints from the
 * phone's copy of the book (phone-sync.ts); anything it fetches goes through
 * API routes that each check access, and proxy turns away a signed-out
 * request, same as /visit.
 */
import { AccountDrawer } from "../../../account/[id]/AccountDrawer";

export const dynamic = "force-static";
export const dynamicParams = true;

export function generateStaticParams(): { id: string }[] {
  return [];
}

export default async function AccountModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AccountDrawer key={id} id={id} />;
}
