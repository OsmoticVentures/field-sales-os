/**
 * Every filed visit gets read once for an email Juan owes the account. A
 * fast model call decides whether the note asks for one (a thank-you he said
 * he would send tonight, a price sheet the buyer asked for, an order to
 * confirm), and when it does, compose.ts writes it under the same grounding
 * gate as every other draft and it lands at the top of Outbound.
 *
 * Runs inside the visit's own filing, beside HubSpot, so the Visit screen
 * hears the outcome on the same line that says Filed: drafted, nothing owed,
 * or the plain reason a needed email could not be written. Never throws: a
 * draft that fails must not fail the note.
 *
 * Once per touchpoint. A retry of the same note replays the first outcome
 * (once + withIdempotency), and an ask already queued for the account, in any
 * status, is never queued twice (asksCollide).
 */
import "server-only";
import { z } from "zod";
import { ai, aiConfigured } from "../../core/ai/client";
import { withIdempotency } from "../../core/idempotency";
import { Held, once } from "../../core/once-server";
import { loadAskInputs } from "./actions";
import { asksCollide, composeAsk } from "./compose";
import { insertAskDraft } from "./dal";

export type VisitOutbound =
  | { status: "drafted"; draftId: string; toEmail: string | null }
  | { status: "already_queued" }
  | { status: "none" }
  | { status: "not_written"; reason: string };

type VisitNote = {
  touchpointId: string;
  accountId: string;
  rawText: string;
  kind: string;
  nextStep: string | null;
  outreachAsks: string[];
};

/** Kinds that are not a customer conversation, or are the email itself. */
const NEVER_DRAFTED = new Set(["field_note", "email_out", "newsletter"]);

/** The descriptions are prompt text, kept word for word from the forced
 *  tool this replaced. */
const DecideSchema = z.object({
  email_needed: z.boolean().describe("true when the note says the rep will, should or needs to email the customer, or send them something by email (a thank-you, a price sheet, a catalog, terms, product info, an order confirmation), or the customer asked for something to be emailed to them. false when the next step is only a call, a text, a WhatsApp, a return visit, or nothing; when the other side will send HIM something; or when the email is internal (to HQ, the orders desk, himself)."),
  ask: z.string().describe("When email_needed: what the email must say or carry, in the rep's own words from the note, kept close to verbatim (e.g. 'send him an email tonight saying thank you so much for the visit and go cobra Kai'). Every item the customer asked for goes in this one string. Empty when not needed."),
  today: z.boolean().describe("true when the note says the email goes out today, tonight, now or right away, or states no later time. false when it states a later time ('in a week')."),
});

const DECIDE_SYSTEM = `You read one note a field sales rep just logged about a customer and decide one thing: does it leave an email he owes that customer?

Only what the note says counts. Never invent an email he did not mention or a customer did not ask for. A promise to "follow up" with no channel is not an email. A text or a call is not an email. When the customer asked him to send them anything, that is an email unless the note names another channel.`;

type Decision = { email_needed: boolean; ask: string; today: boolean };

async function decide(note: VisitNote): Promise<Decision | string> {
  // What the visit parse already caught is the decision, with no model call.
  if (note.outreachAsks.length > 0) {
    return { email_needed: true, ask: note.outreachAsks.join("; "), today: true };
  }
  if (!aiConfigured()) return "no model is configured on this deployment";
  try {
    const { data } = await ai({
      task: "outbound_decide",
      system: DECIDE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `NOTE:\n${note.rawText}\n\nNEXT STEP AS FILED: ${note.nextStep ?? "(none stated)"}`,
        },
      ],
      schema: DecideSchema,
    });
    return { email_needed: data.email_needed, ask: data.ask.trim(), today: data.today };
  } catch (err) {
    return err instanceof Error ? err.message.replace(/\.$/, "").toLowerCase() : String(err);
  }
}

/** The ask is the decider's words, and compose.ts treats it as a source. A
 *  number in it that the note never said would pass the fabrication check,
 *  so such an ask falls back to the note's own next step. */
function groundedAsk(ask: string, note: VisitNote): string {
  const said = new Set([...(note.rawText.match(/\d+/g) ?? []), ...((note.nextStep ?? "").match(/\d+/g) ?? [])]);
  const clean = (ask.match(/\d+/g) ?? []).every((n) => said.has(n));
  return clean && ask ? ask : note.nextStep?.trim() || note.rawText;
}

async function run(note: VisitNote): Promise<VisitOutbound> {
  if (NEVER_DRAFTED.has(note.kind)) return { status: "none" };

  const decision = await decide(note);
  if (typeof decision === "string") return { status: "not_written", reason: `Email not drafted: ${decision}.` };
  if (!decision.email_needed) return { status: "none" };

  const ask = groundedAsk(decision.ask, note);
  const { account, contacts, alreadyFiled, voice } = await loadAskInputs(note.accountId);
  if (!account) return { status: "not_written", reason: "Email not drafted: that account is not in your book." };
  if (alreadyFiled.some((r) => asksCollide(r.source_ask, ask))) return { status: "already_queued" };

  const composed = await composeAsk({
    ask,
    noteText: [note.rawText, note.nextStep ? `Next step: ${note.nextStep}` : null].filter(Boolean).join("\n\n"),
    account: { id: account.id, name: account.name, city: account.city, email: account.email },
    contacts,
    voice,
  });
  if (!composed.written) {
    return { status: "not_written", reason: composed.reason.replace(/^Not written:\s*/i, "Email not drafted: ") };
  }

  const row = await insertAskDraft({
    account_id: note.accountId,
    ask,
    composed,
    urgency: decision.today ? { level: 2, reason: "Owed from today's visit" } : { level: 1, reason: "Owed from a visit" },
  });
  if (!row) return { status: "not_written", reason: "Email not drafted: the draft did not save." };
  return { status: "drafted", draftId: row.id, toEmail: row.to_email };
}

/** A refusal is not kept under the touchpoint's key, so the next filing of
 *  the same note (or the backfill script) gets a fresh try at it. */
class Refused extends Error {
  constructor(readonly outcome: VisitOutbound) {
    super("not written");
  }
}

export async function draftFromVisit(note: VisitNote): Promise<VisitOutbound> {
  try {
    // once() makes it atomic across a double tap and two instances (the
    // ask-collision check alone reads before either has written); the inner
    // withIdempotency keeps replaying outcomes stored before once() existed.
    const key = `outbound:visit:${note.touchpointId}`;
    const { result } = await once(key, async () => {
      const { result: inner } = await withIdempotency(key, async () => {
        const out = await run(note);
        if (out.status === "not_written") throw new Refused(out);
        return out;
      });
      return inner;
    });
    return result;
  } catch (err) {
    if (err instanceof Refused) return err.outcome;
    if (err instanceof Held) return { status: "already_queued" };
    return { status: "not_written", reason: `Email not drafted: ${err instanceof Error ? err.message : String(err)}.` };
  }
}
