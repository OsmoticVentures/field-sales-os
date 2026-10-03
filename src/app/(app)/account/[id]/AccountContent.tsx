/**
 * The client view as the full page renders it on a direct visit or refresh:
 * the same payload the phone keeps (account-payload.ts), read fresh on the
 * server, handed to the same AccountClient the slide-over uses, which also
 * keeps it on the phone. Ported from portfolio/src/app/nutribiotic/account/[id]/page.tsx
 * and lib/account-detail.tsx.
 */
import { notFound } from "next/navigation";
import { readAccountLive, readAccountPayload } from "../../../../lib/features/clients/account-payload";
import { AccountClient } from "./AccountClient";

export async function AccountContent({ id }: { id: string }) {
  const [payload, live] = await Promise.all([readAccountPayload(id), readAccountLive(id).catch(() => undefined)]);
  if (!payload) notFound();
  return <AccountClient id={id} initial={payload} initialLive={live} />;
}
