/**
 * The Mac's door for a store Juan named that is not in the book yet: the
 * same createAccountForNote the Visit screen uses (Places enrichment,
 * portal-wide duplicate check, company, account). clients.py --new-account
 * calls this, then files the note to the account it returns. A second call
 * for the same store finds the first one's company and returns that account,
 * so a retry never creates twice.
 */
import { macAuthorized } from "../../../../lib/core/mac-auth";
import { AlreadyInHubspot, createAccountForNote } from "../../../../lib/features/visit/new-account";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!macAuthorized(req)) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });

  const body = await req.json().catch(() => null);
  const name = (body?.name as string | undefined)?.trim();
  if (!name) return Response.json({ ok: false, error: "name is required." }, { status: 400 });
  const city = (body?.city as string | undefined)?.trim() || null;

  try {
    return Response.json({ ok: true, result: await createAccountForNote({ name, city }) });
  } catch (err) {
    if (err instanceof AlreadyInHubspot) return Response.json({ ok: false, error: err.message }, { status: 409 });
    captureError(err, "/api/mac/new-account");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not create that account." }, { status: 500 });
  }
}
