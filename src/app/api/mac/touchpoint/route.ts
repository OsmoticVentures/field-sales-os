/**
 * The Mac's door onto the one extractor: bridges/nutribiotic/clients.py, the
 * `cliente` capture. Same recordTouchpoint as the Visit screen, so the parse,
 * the account match and the contact rule are identical whichever door was used.
 *
 * The note is normally read on the Mac, on Juan's Max plan, against
 * api/mac/extract-spec, and arrives as `mac_parsed`; without one, this
 * server reads it on the metered key.
 *
 * It writes the OS only. clients.py files HubSpot itself after its dry-run
 * review, so autoFileHubspot is off here. A note whose store is not clear
 * answers 409 with nothing written, the parse and the closest accounts; the
 * caller asks and resends with account_id and that parse, so the pick costs
 * no second model call.
 */
import { macAuthorized } from "../../../../lib/core/mac-auth";
import { recordTouchpoint, type ParsedTouchpoint } from "../../../../lib/features/visit/touchpoint";
import { invalidatePriorityBook } from "../../../../lib/features/prospect/dal";
import { AI_CAP_STATUS, isAiCap } from "../../../../lib/core/ai/client";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!macAuthorized(req)) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });

  const body = await req.json().catch(() => null);
  const text = (body?.text as string | undefined)?.trim();
  if (!text) return Response.json({ ok: false, error: "text is required." }, { status: 400 });
  const accountIdHint = (body?.account_id as string | undefined) || null;
  const occurredAt = (body?.occurred_at as string | undefined) || null;
  const parsed = (body?.parsed as ParsedTouchpoint | undefined) ?? null;
  const macParsed = (body?.mac_parsed as unknown) ?? undefined;

  // A new touch moves the priority score; the next read recomputes it.
  invalidatePriorityBook();

  let result;
  try {
    result = await recordTouchpoint(text, accountIdHint, { occurredAt, parsed, macParsed, autoFileHubspot: false });
  } catch (err) {
    if (isAiCap(err)) return Response.json({ ok: false, error: err.message }, { status: AI_CAP_STATUS });
    throw err;
  }
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 422 });
  if (result.needsAccount) {
    const guess = result.businessNameGuess ? `"${result.businessNameGuess}"` : "the store";
    return Response.json(
      {
        ok: false,
        needs_account: true,
        error: `Not filed: couldn't tell which account ${guess} is.`,
        business_name_guess: result.businessNameGuess,
        match: result.matchAccountId ? { id: result.matchAccountId, name: result.matchAccountName } : null,
        candidates: result.candidates,
        parsed: result.parsed,
      },
      { status: 409 },
    );
  }
  return Response.json({ ok: true, result });
}
