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
import { ai, aiConfigured, aiViaCli, isAiCap, isAiCredits } from "../../core/ai/client";
import { currentUser, DEFAULT_USER } from "../../core/user";
import { withIdempotency } from "../../core/idempotency";
import { Held, laDay, once } from "../../core/once-server";
import { loadAskInputs } from "./actions";
import { asksCollide, composeAsk } from "./compose";
import { insertAskDraft, insertFollowUpDirective } from "./dal";

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
  /** People the note says handed over an email address at this visit. */
  givenEmails?: GivenEmail[];
};

export type GivenEmail = { name: string; email: string };

type Person = { first_name?: string | null; last_name?: string | null; email?: string | null };

/** An email address counts as handed over only when the note itself says it,
 *  so an address enrichment found on a website never triggers a draft. */
export function givenEmails(rawText: string, people: Person[] | undefined): GivenEmail[] {
  const text = rawText.toLowerCase();
  return (people ?? [])
    .filter((p): p is Person & { email: string } => Boolean(p.email && text.includes(p.email.toLowerCase())))
    .map((p) => ({ name: [p.first_name, p.last_name].filter(Boolean).join(" ").trim(), email: p.email }));
}

/** Someone gave him their email: the first email to them is owed, in the
 *  note's own terms. No fact beyond the name and the address is added. */
function givenEmailAsk(given: GivenEmail[]): string {
  const who = given.map((g) => (g.name ? `${g.name} (${g.email})` : g.email)).join(" and ");
  return `First email after the visit to ${who}, who gave this email at the visit`;
}

/** Kinds that are not a customer conversation, or are the email itself. */
const NEVER_DRAFTED = new Set(["field_note", "email_out", "newsletter"]);

/** The descriptions are prompt text, kept word for word from the forced
 *  tool this replaced. */
const DecideSchema = z.object({
  email_needed: z.boolean().describe("true when the note says the rep will, should or needs to email the customer, or send them something by email (a thank-you, a price sheet, a catalog, terms, product info, an order confirmation), or the customer asked for something to be emailed to them. false when the next step is only a call, a text, a WhatsApp, a return visit, or nothing; when the other side will send HIM something; or when the email is internal (to HQ, the orders desk, himself)."),
  ask: z.string().describe("When email_needed: what the email must say or carry, in the rep's own words from the note, kept close to verbatim (e.g. 'send him an email tonight saying thank you so much for the visit and go cobra Kai'). Every item the customer asked for goes in this one string. Empty when not needed."),
  today: z.boolean().describe("true when the note says the email goes out today, tonight, now or right away, or states no later time. false when it states a later time ('in a week')."),
  follow_up_on: z.string().nullable().describe("When the note says he will follow up, reach out again, check back or email this customer at a LATER time, with no call, text or visit named: the approximate day, YYYY-MM-DD, resolved against TODAY. A named month is its first weekday, 'next week' is next Monday, 'in two weeks' is 14 days out, 'in a month' is 30 days out, and a later follow-up with no time stated is 7 days out. null when no later follow-up is stated, or when it is a call, a text or a visit."),
  follow_up_what: z.string().describe("When follow_up_on is set: what the follow-up is about, in the rep's own words from the note. Empty otherwise."),
});

const DECIDE_SYSTEM = `You read one note a field sales rep just logged about a customer and decide one thing: does it leave an email he owes that customer?

Only what the note says counts. Never invent an email he did not mention or a customer did not ask for. A promise to "follow up" later with no channel is not an email owed now: it is a follow-up for a later day (follow_up_on). A text or a call is not an email. When the customer asked him to send them anything, that is an email unless the note names another channel. When someone at the account gave him an email address, that is an email he owes: the first email to that person after the visit.`;

type Decision = {
  email_needed: boolean;
  ask: string;
  today: boolean;
  followUp?: { on: string; what: string };
};

/** The decision could not be made because the day's AI limit is reached. */
const CAPPED = Symbol("capped");

async function decide(note: VisitNote): Promise<Decision | string | { [CAPPED]: string }> {
  // What the visit parse already caught is the email decision; the model
  // still reads the note for a later follow-up.
  const caught = note.outreachAsks.length > 0 ? { email_needed: true, ask: note.outreachAsks.join("; "), today: true } : null;
  if (!aiConfigured()) return caught ?? "no model is configured on this deployment";
  try {
    const { data } = await ai({
      task: "outbound_decide",
      system: DECIDE_SYSTEM,
      messages: [
        {
          role: "user",
          content: `TODAY: ${laDay()}\n\nNOTE:\n${note.rawText}\n\nNEXT STEP AS FILED: ${note.nextStep ?? "(none stated)"}`,
        },
      ],
      schema: DecideSchema,
    });
    const on = data.follow_up_on && /^\d{4}-\d{2}-\d{2}$/.test(data.follow_up_on) && data.follow_up_on > laDay() ? data.follow_up_on : null;
    return {
      ...(caught ?? { email_needed: data.email_needed, ask: data.ask.trim(), today: data.today }),
      ...(on ? { followUp: { on, what: data.follow_up_what.trim() || note.nextStep?.trim() || "Follow up after the visit" } } : {}),
    };
  } catch (err) {
    if (caught) return caught;
    if (isAiCap(err) || isAiCredits(err)) return { [CAPPED]: err.message };
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

  const given = note.givenEmails ?? [];
  const decision = await decide(note);
  if (typeof decision === "string") return { status: "not_written", reason: `Email not drafted: ${decision}.` };
  if (CAPPED in decision) return { status: "not_written", reason: `Email not drafted. ${decision[CAPPED]}` };
  // An email handed over at the visit is owed even when the note never says
  // "email them" (2026-11-03: a buyer's address sat in a note, nothing drafted).
  if (decision.followUp) {
    // A later follow-up is drafted on its day by scripts/draft-from-visits.ts
    // --sweep, from this directive (Juan, 2026-11-03).
    await insertFollowUpDirective({
      id: `dir_fu_${note.touchpointId}`,
      accountId: note.accountId,
      on: decision.followUp.on,
      what: decision.followUp.what,
      quote: note.rawText,
    }).catch(() => undefined);
  }
  if (!decision.email_needed && given.length) {
    decision.email_needed = true;
    decision.ask = givenEmailAsk(given);
    decision.today = true;
  }
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
    return { status: "not_written", reason: composed.reason.replace(/^Not written([:.])\s*/i, "Email not drafted$1 ") };
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
  // Juan's emails are written on the Max plan, by the Mac's sweep while the
  // laptop is open (scripts/draft-from-visits.ts). Nothing is stored here, so
  // the sweep finds this note still open. Another rep's stay on the API.
  if (!aiViaCli() && (await currentUser().then((u) => u.id).catch(() => null)) === DEFAULT_USER) return { status: "none" };
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
