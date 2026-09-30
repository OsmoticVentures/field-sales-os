/**
 * The client view opened from inside the app: a slide-over above the screen
 * that linked to it. The screen underneath stays mounted, so swiping back
 * lands on it untouched (tab, scroll, filters, map, typing).
 *
 * The sheet slides in at once with the client view's skeleton and the
 * content streams into it, rather than the tap waiting on every read.
 */
import { Suspense } from "react";
import { AccountContent } from "../../../account/[id]/AccountContent";
import { AccountSheet } from "../../../account/[id]/AccountSheet";
import AccountSkeleton from "../../../account/[id]/loading";

export const dynamic = "force-dynamic";

export default async function AccountModal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AccountSheet>
      <Suspense key={id} fallback={<AccountSkeleton />}>
        <AccountContent id={id} />
      </Suspense>
    </AccountSheet>
  );
}
