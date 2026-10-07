/**
 * The account's contacts after a live HubSpot refresh (lib/features/prospect/
 * live-contacts.ts). The panel calls this once it has painted, so a slow
 * portal never holds up the account itself. Read-only on HubSpot.
 */
import { hasAccess } from "../../../../../../lib/core/devices";
import { getAccount, listContacts, panelContact } from "../../../../../../lib/features/prospect/dal";
import { refreshLiveContacts } from "../../../../../../lib/features/prospect/live-contacts";

export const runtime = "nodejs";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const { id } = await params;
  const account = await getAccount(id);
  if (!account) return Response.json({ ok: false, error: "Account not found." }, { status: 404 });
  await refreshLiveContacts(account as unknown as Parameters<typeof refreshLiveContacts>[0]);
  const contacts = await listContacts(id);
  return Response.json(
    { ok: true, accountId: id, contacts: contacts.map(panelContact) },
    { headers: { "cache-control": "no-store" } },
  );
}
