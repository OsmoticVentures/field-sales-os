/**
 * The client view opened from inside the app: a slide-over above the screen
 * that linked to it. The screen underneath stays mounted, so swiping back
 * lands on it untouched (tab, scroll, filters, map, typing).
 *
 * Static: no access check and no reads here. The view paints from the
 * phone's copy of the book (phone-sync.ts); anything it fetches goes through
 * API routes that each check access, and proxy turns away a signed-out
 * request, same as /visit.
 */
import { AccountClient } from "../../../account/[id]/AccountClient";
import { AccountSheet } from "../../../account/[id]/AccountSheet";

export const dynamic = "force-static";
export const dynamicParams = true;

export function generateStaticParams(): { id: string }[] {
  return [];
}

export default async function AccountModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AccountSheet>
      <AccountClient key={id} id={id} />
    </AccountSheet>
  );
}
