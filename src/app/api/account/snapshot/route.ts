/**
 * THE TWICE-DAILY DOWNLOAD. Every client in Juan's working book, in one
 * response, for the phone store (lib/core/phone-sync.ts), so opening a client
 * paints from the phone with no server wait. Five paged bulk reads plus the
 * priority book, never eight reads per client.
 *
 * BYTES PER RUN: 837,212 bytes (0.84 MB) in about 1.2 s for 320 accounts,
 * measured by hand 2026-10-02 against the real tables. The phone runs it at
 * most twice a day, so about 1.7 MB a day of the shared Supabase egress.
 *
 * BOUND: the phone rewrites its store whole at each sync, so nothing
 * appends; the response is bounded by the book.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { readBookPayloads } from "../../../../lib/features/clients/account-payload";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  try {
    const accounts = await readBookPayloads();
    return Response.json({ ok: true, builtAt: new Date().toISOString(), accounts }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    captureError(err, "/api/account/snapshot");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not read the book." }, { status: 500 });
  }
}
