/**
 * Outbound: the queue of drafted outreach waiting on Juan. Ported from the
 * NutriBiotic OS's outbound/page.tsx, scoped to what this port carries, the
 * grounded email drafts ask-compose.ts writes (draftAccountPitch,
 * draftAccountPitchFromReason). The source screen's WhatsApp/iMessage
 * composer and its manual-email logging box are not ported, see this
 * feature's handback: every draft this screen shows is an email, either
 * addressed and ready to open in Outlook, or, when no email is on file,
 * ready to copy into the store's own website contact form. Nothing on this
 * screen sends anything: Open in Outlook opens a compose window Juan sends
 * from himself, and Mark sent only records his own word that he sent it.
 */
import { PageHead } from "../../../lib/core/ui";
import { isConfigured, listPendingDrafts } from "../../../lib/features/outbound/dal";
import { getAccountNames } from "../../../lib/features/visit/dal";
import { OutboundClient } from "./OutboundClient";

export const dynamic = "force-dynamic";

export const metadata = { title: "Outbound · Field Sales OS" };

export default async function OutboundPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const accountFilter = (await searchParams).account?.trim() || null;

  if (!isConfigured()) {
    return (
      <>
        <PageHead title="Outbound" />
        <p className="text-[15px] text-[#5B6560]">No data source configured.</p>
      </>
    );
  }

  const drafts = await listPendingDrafts();
  const accountIds = [...new Set(drafts.map((d) => d.account_id).filter((id): id is string => Boolean(id)))];
  const names = await getAccountNames(accountIds);
  const rows = drafts.map((draft) => ({ draft, accountName: draft.account_id ? names[draft.account_id] ?? null : null }));

  return (
    <>
      <PageHead title="Outbound" />
      <OutboundClient initialRows={rows} accountFilter={accountFilter} accountName={accountFilter ? names[accountFilter] ?? null : null} />
    </>
  );
}
