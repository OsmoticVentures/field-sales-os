/**
 * One search bar, both a business name and a person's name, no mode toggle.
 * Runs both lookups in parallel and dedupes by account, so a company-name
 * hit and a person-name hit on the same account show once, with the
 * contact attached to the account row. A GET, no idempotency key: nothing
 * here writes.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { searchOwnedAccounts, searchOwnedContacts } from "../../../../lib/features/prospect/dal";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return Response.json({ ok: true, hits: [] });

  const [accounts, contacts] = await Promise.all([searchOwnedAccounts(q, 6), searchOwnedContacts(q, 6)]);
  const byAccount = new Map<string, { accountId: string; accountName: string; city: string | null; phone: string | null; area: string | null; contactName: string | null; contactTitle: string | null }>();
  for (const a of accounts) {
    byAccount.set(a.id, { accountId: a.id, accountName: a.name, city: a.city, phone: a.phone, area: a.area, contactName: null, contactTitle: null });
  }
  for (const c of contacts) {
    const existing = byAccount.get(c.account_id);
    if (existing && !existing.contactName) byAccount.set(c.account_id, { ...existing, contactName: c.name, contactTitle: c.title });
    else if (!existing) byAccount.set(c.account_id, { accountId: c.account_id, accountName: c.account_name, city: c.city, phone: c.phone, area: null, contactName: c.name, contactTitle: c.title });
  }
  return Response.json({ ok: true, hits: [...byAccount.values()].slice(0, 8) });
}
