/**
 * The current pay period's label plus a direct link to its spreadsheet, for
 * the "open the sheet" button. Creating the tree here (rather than guessing
 * the sheet name) means the link is always real. Ported unchanged from the
 * NutriBiotic OS (portfolio/src/app/nutribiotic/api/expenses/summary/route.ts).
 * A read, not a write, no idempotency key needed.
 */
import { periodSummary } from "../../../../lib/shared/expenses";
import { hasAccess } from "../../../../lib/core/devices";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD
  try {
    const summary = await periodSummary(today);
    return Response.json({ ok: true, today, ...summary });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not reach Drive." }, { status: 500 });
  }
}
