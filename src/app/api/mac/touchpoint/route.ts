/**
 * The Mac's door onto the one extractor: bridges/nutribiotic/clients.py, the
 * `cliente` capture. Same recordTouchpoint as the Visit screen, so the parse,
 * the account match and the contact rule are identical whichever door was used.
 *
 * Bearer-gated (NB_SESSION_SECRET): no browser session, the Mac is the only
 * caller, and with no cookie the request acts as the default rep (Juan).
 *
 * It writes the OS only. clients.py files HubSpot itself after its dry-run
 * review, so autoFileHubspot is off here. A note whose store is not clear
 * answers 409 with nothing written; the caller asks and resends with
 * account_id.
 */
import { recordTouchpoint } from "../../../../lib/features/visit/touchpoint";
import { AI_CAP_STATUS, isAiCap } from "../../../../lib/core/ai/client";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const expected = process.env.NB_SESSION_SECRET;
  if (!expected || req.headers.get("authorization") !== `Bearer ${expected}`) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const text = (body?.text as string | undefined)?.trim();
  if (!text) return Response.json({ ok: false, error: "text is required." }, { status: 400 });
  const accountIdHint = (body?.account_id as string | undefined) || null;
  const occurredAt = (body?.occurred_at as string | undefined) || null;

  let result;
  try {
    result = await recordTouchpoint(text, accountIdHint, { occurredAt, autoFileHubspot: false });
  } catch (err) {
    if (isAiCap(err)) return Response.json({ ok: false, error: err.message }, { status: AI_CAP_STATUS });
    throw err;
  }
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 422 });
  if (result.needsAccount) {
    const guess = result.businessNameGuess ? `"${result.businessNameGuess}"` : "the store";
    const match = result.matchAccountName ? ` Closest account: ${result.matchAccountName} (${result.matchAccountId}).` : "";
    return Response.json(
      {
        ok: false,
        needs_account: true,
        error: `Not filed: couldn't tell which account ${guess} is.${match} Resend with account_id.`,
        business_name_guess: result.businessNameGuess,
        match_account_id: result.matchAccountId,
        match_account_name: result.matchAccountName,
      },
      { status: 409 },
    );
  }
  return Response.json({ ok: true, result });
}
