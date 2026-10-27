/**
 * The Prospect dashboard's read (lib/features/prospect/intel.ts). The phone
 * paints the last answer from its own copy and asks here underneath, so this
 * is never on the path to a first paint.
 *
 * The summary is written after the response, never before it: when the facts
 * have moved, one short model call reads them and the next open shows it. A
 * summary that states a number the facts do not is thrown away, so the
 * screen keeps the last good one.
 */
import { after } from "next/server";
import { z } from "zod";
import { hasAccess } from "../../../../lib/core/devices";
import { captureError } from "@/lib/core/errors";
import { currentUser } from "../../../../lib/core/user";
import { ai, aiConfigured } from "../../../../lib/core/ai/client";
import { getIntel, numbersTraced, storeSummary, summaryFacts, summaryStale } from "../../../../lib/features/prospect/intel";

export const runtime = "nodejs";
export const maxDuration = 30;

const SummarySchema = z.object({
  summary: z.string().describe("Two or three short sentences, plain words, no greeting, no em dashes."),
});

export async function GET() {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  try {
    const me = await currentUser();
    const intel = await getIntel();
    if (aiConfigured() && summaryStale(me.id, intel)) {
      after(async () => {
        try {
          const facts = summaryFacts(intel);
          const { data } = await ai({
            task: "prospect_intel_summary",
            actor: me.id,
            system:
              "You write the top line of a field sales rep's prospecting dashboard: two or three short sentences " +
              "that say what matters today and what to do first. Use only the facts given. Never add a number, a " +
              "name, or a claim the facts do not state. Plain, direct words, second person, no hype, no greeting, " +
              "no em dashes, no lists.",
            messages: [{ role: "user", content: JSON.stringify(facts) }],
            schema: SummarySchema,
          });
          const text = data.summary.replace(/—/g, ",").trim();
          if (text && numbersTraced(text, facts)) await storeSummary(me.id, intel, text);
        } catch (err) {
          captureError(err, "/api/prospect/intel summary");
        }
      });
    }
    return Response.json(intel);
  } catch (err) {
    captureError(err, "/api/prospect/intel");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not read the dashboard." }, { status: 500 });
  }
}
