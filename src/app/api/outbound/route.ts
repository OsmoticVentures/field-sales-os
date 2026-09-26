/**
 * The Outbound queue itself: every pending draft, most urgent first, with
 * the account name resolved so the screen never shows a bare id. Ported
 * from the read side of the NutriBiotic OS's outbound/page.tsx.
 */
import { hasAccess } from "../../../lib/core/devices";
import { getAccountNames } from "../../../lib/features/visit/dal";
import { isConfigured, listPendingDrafts } from "../../../lib/features/outbound/dal";

export const runtime = "nodejs";

export async function GET() {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  if (!isConfigured()) return Response.json({ ok: true, rows: [] });

  try {
    const drafts = await listPendingDrafts();
    const accountIds = [...new Set(drafts.map((d) => d.account_id).filter((id): id is string => Boolean(id)))];
    const names = await getAccountNames(accountIds);
    const rows = drafts.map((draft) => ({ draft, accountName: draft.account_id ? names[draft.account_id] ?? null : null }));
    return Response.json({ ok: true, rows });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't load Outbound." }, { status: 500 });
  }
}
