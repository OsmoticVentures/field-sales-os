/**
 * The client view opened from inside the app: a slide-over above the screen
 * that linked to it. The screen underneath stays mounted, so swiping back
 * lands on it untouched (tab, scroll, filters, map, typing).
 */
import { AccountContent } from "../../../account/[id]/AccountContent";
import { AccountSheet } from "../../../account/[id]/AccountSheet";

export const dynamic = "force-dynamic";

export default async function AccountModal({ params }: { params: Promise<{ id: string }> }) {
  return (
    <AccountSheet>
      <AccountContent id={(await params).id} />
    </AccountSheet>
  );
}
