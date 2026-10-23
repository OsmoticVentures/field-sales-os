/**
 * Turn a customer ask, or an account's own Gap Selling summary, into an
 * email Juan could actually send. Ported from
 * portfolio/src/app/nutribiotic/lib/ask-compose.ts, same prompt, same
 * checks, same refusal behavior. Nothing here is loosened: a draft that
 * fails the grounding gate is returned unwritten, exactly as the source
 * does, and the caller stores that unwritten form rather than retrying past
 * it.
 *
 * NO FABRICATION IS THE POINT (root AGENTS.md P2). Every composed email is
 * run through groundingFailure() before it can be stored, and a failure is
 * not a retry or a warning: fabricationFailure ends the attempt outright, a
 * style failure gets one corrective retry, and either way a row that could
 * not be written says so plainly rather than impersonating a draft.
 *
 * AN ASK IS NOT ALWAYS AN EMAIL. Something the other side will send him, or
 * a note to himself, comes back unwritten with a reason instead of being
 * dressed up into an email nobody asked for.
 *
 * THE VOICE COMES FROM HIS OWN SENT MAIL, never a hand-typed paraphrase of
 * house style: email-voice.generated.ts and talking-points.generated.ts are
 * both ported copies of files built from what he actually sent (see their
 * own file headers).
 */
import "server-only";
import { z } from "zod";
import { ai, aiConfigured, isAiCap } from "../../core/ai/client";
import { EMAIL_VOICE } from "./email-voice.generated";
import { TALKING_POINTS } from "./talking-points.generated";
import { fabricationFailure, styleFailure } from "./gates";

export { asksCollide, normalizeAsk, specificityFailure, fabricationFailure, styleFailure, groundingFailure } from "./gates";

export type AskContact = {
  id: string;
  /** Full name as it is on file, first name first. Empty names are not passed. */
  name: string;
  title: string | null;
  email: string | null;
};

export type AskAccount = {
  id: string;
  name: string;
  city: string | null;
  /** The store's own general address, used only when no named contact has one. */
  email: string | null;
};

/** What Juan's own rewrites of past drafts teach this one (voice_lessons/voice_pairs). */
export type VoiceContext = {
  lessons: { lesson: string; before: string | null; after: string | null; seen: number }[];
  pairs: { draft: string; sent: string }[];
};

export type ComposeAskInput = {
  /** What the customer asked for, in the rep's own words, verbatim. */
  ask: string;
  /** The full note the ask was extracted from. With the account record and the
   *  approved talking points, the only sources of truth. */
  noteText: string;
  account: AskAccount;
  contacts: AskContact[];
  voice?: VoiceContext;
  /** Whose email this is. Absent means Juan, the original author of every rule here. */
  rep?: Rep;
};

/** The rep an email is written for: the name it is signed with and the territory it speaks from. */
export type Rep = { first: string; full: string; region: string };
export const JUAN: Rep = { first: "Juan", full: "Juan Arenas", region: "Southern California" };
const REGIONS: Record<string, string> = { juan: "Southern California", kyle: "Northern California" };

/** The signed-in rep. A request with no rep behind it (a script) is Juan's. */
export async function currentRep(): Promise<Rep> {
  try {
    const { currentUser } = await import("../../core/user");
    const u = await currentUser();
    const first = u.name.split(/\s+/)[0];
    return { first, full: u.name, region: REGIONS[u.id] ?? "California" };
  } catch {
    return JUAN;
  }
}

/** Facts Juan wrote in his own sent mail and approved as a source, 2026-09-23.
 *  Source text for the number check, like the note. */
const TALKING_POINT_TEXT = TALKING_POINTS.map((t) => t.line).join("\n");

export type ComposedAsk =
  | {
      written: true;
      subject: string;
      body: string;
      contactId: string | null;
      toName: string | null;
      toEmail: string | null;
    }
  | { written: false; reason: string };

// ---------------------------------------------------------------------------
// The composition itself.
// ---------------------------------------------------------------------------

/** What the model returns for one ask. The descriptions are prompt text,
 *  kept word for word from the forced tool this replaced. */
const ComposeSchema = z.object({
  writable: z.boolean().describe("true only when the note says enough to write an email the rep could send as-is, and the ask is something HE sends. false when the ask is something the other side will send him, when it is an internal reminder rather than a message, or when writing it would need a fact nobody stated."),
  reason: z.string().describe("When writable is false, one plain sentence naming what is missing or why this is not an email he sends, addressed to the rep as 'you'. Empty string when writable is true."),
  contact_id: z.string().nullable().describe("The id of the ONE person this email is addressed to, from the contacts list given. The person who made the ask when the note names them. Null when no listed contact is the right recipient."),
  subject: z.string().describe("A short, plain subject naming what this email is about, in sentence case: only proper nouns and product names are capitalized. A noun phrase, never marketing copy, never internal words like 'next step' or 'follow-up action'. Good: 'Chlorella and Defense Plus', 'Order list, per Susan', 'Getting Kim looped in on Clarity+'. Empty string when writable is false."),
  body: z.string().describe("The email, greeting to sign-off. Empty string when writable is false."),
});

function systemPrompt(rep: Rep): string {
  return `You write one short follow-up email for ${rep.full}, NutriBiotic's ${rep.region} field sales rep, from a note he typed after a visit or a call.

YOU MAY ONLY RE-WORD WHAT THE NOTE AND THE ACCOUNT RECORD ALREADY SAY. This is the hardest rule you have. You may re-order it, tighten it, and make it read like an email. You may never introduce a product, a price, a quantity, a date, a discount, a delivery time, a document, or a promise that is not already in the material given to you. If the note does not say when he is coming back, the email does not say when he is coming back. A number that is not in the note is an invention, and an invented number reaches a real customer.

WHAT IS NOT WRITABLE. Say so instead of writing something:
- The ask is something the OTHER side will send or do ("they will quote me", "the owner is expected to email me"). There is nothing for him to send yet.
- The ask is a note to himself, not a message to anyone.
- Writing it would need a fact nobody stated: a price, a sell-through figure, a document that does not exist.
Being honest that it cannot be written is always better than writing something plausible. A vague ask is still writable if he can honestly acknowledge it and say he is putting it together, as long as he promises nothing specific that the note does not already contain.

HOW HE WRITES. What follows is the agency's voice file, written from the lead rep's sent mail, with a real line behind every rule.${rep.first === "Juan" ? "" : ` Where it says "Juan" or "I'm Juan", read ${rep.first}; the habits and structure are the house style, and you copy them, never a name or fact from them.`} Follow it over any instinct you have about how a sales email is supposed to read. Where it describes a habit, copy the habit, not the example sentence.

${EMAIL_VOICE}

WHAT THIS EMAIL IS FOR. Your habit is to write a report of his visit note. He rewrites every one of those into a pitch: an appointment, or a straight ask for the sale. Most of these are a first email to a store or a clinic, so write it as one unless the note shows he is answering something they sent.

1. Name everyone on their team that the note or the contacts list names, in the first two lines: who connected you, who he met, who he is writing to. "Hi Honey and Susan," / "Following up after meeting with Carmen." / "Miriam told me this address is the way to reach Mehrdad."

2. In a first email, say who he is in one line: "I'm ${rep.first}, your representative with NutriBiotic." Not in a reply.

3. Turn account data into the relationship: "Your company has been trusting NutriBiotic for years." Never recite order dates or order history; those are his notes, not their news.

4. Give the reason it helps THEM: helping them sell the products and inform their customers is his job as their rep. "help you sell our products better" / "so your team can better inform customers". Never "go through what is moving and what is not".

5. You may use one or two APPROVED TALKING POINTS (below) when they fit, close to verbatim. They are facts he wrote himself. Nothing else outside the note is a fact.

6. The ask is his to propose, and small. Offer a day or a window rather than asking them to pick one ("Do you have 15 minutes Thursday or Friday morning?", "How is next Monday?"), and use a day or time the note states when it states one. Never write a clock time or a date that is not in the note. When they are ready to buy, the ask is the order itself.

7. Time is relative: "a couple weeks ago", "recently", "two days ago", never the exact date from the note unless it was a day or two ago. Leave out logistics they already know or that go without saying ("with at least a week of notice", "so I am writing here").

8. An attachment is never mentioned alone: say what it is for ("so you can see all products and prices", "helpful to print and show to customers"), and mention one only when the note says he is sending it.

9. Every sentence carries a fact from the note, a talking point, a concrete ask, or a specific kindness about that person. A sentence that would read the same for any account is filler and is refused. "Let me know what other information you need from me to move forward" is refused.

10. Close with appreciation, "Thank you," or "Thanks," ("Gracias," to a Spanish-speaking buyer), then his first name alone, "${rep.first}", on its own line. Never type "${rep.full}" or a company line: his mail client adds the block.

11. Greet by first name: "Hi Julie,". If no named person fits, open with "Hello,".

A first email runs four to six short paragraphs of one or two sentences each. A reply is shorter.

APPROVED TALKING POINTS:
${TALKING_POINTS.map((t) => `- (${t.topic}) ${t.line}`).join("\n")}`;
}

function userPrompt(input: ComposeAskInput, rep: Rep): string {
  const contacts = input.contacts.length
    ? input.contacts
        .map((c) => `${c.id} · ${c.name}${c.title ? `, ${c.title}` : ""}${c.email ? ` · ${c.email}` : " · no email on file"}`)
        .join("\n")
    : "(nobody on file for this account)";

  return `ACCOUNT: ${input.account.name}${input.account.city ? `, ${input.account.city}` : ""}

CONTACTS ON FILE (pick the recipient from these, by id):
${contacts}

THE ASK, in ${rep.first}'s own words:
${input.ask}

THE FULL NOTE the ask came from, which is the only other thing you know:
${input.noteText}${voiceSection(input.voice)}`;
}

/** His own corrections of earlier drafts. Habits to copy, never facts: a
 *  name, product or number in a pair belongs to that other email, and the
 *  checks refuse it here. */
function voiceSection(voice?: VoiceContext): string {
  if (!voice || (!voice.lessons.length && !voice.pairs.length)) return "";
  const lessons = voice.lessons
    .map((l) => `- ${l.lesson}${l.before || l.after ? ` (draft: "${l.before ?? ""}" -> he sent: "${l.after ?? ""}")` : ""}`)
    .join("\n");
  const pairs = voice.pairs
    .map((p, i) => `EXAMPLE ${i + 1}. A draft like yours:\n${p.draft}\n\nWhat he actually sent instead:\n${p.sent}`)
    .join("\n\n");
  return `

WHAT HE KEEPS CHANGING IN DRAFTS LIKE THIS ONE. Each line below is a correction he has made by hand more than once. Write it his way the first time.
${lessons || "(none yet)"}

${pairs}

Copy the habits in those examples, never their facts: their names, products and numbers belong to other customers.`;
}

type ComposeOut = z.infer<typeof ComposeSchema>;

async function askModel(input: ComposeAskInput, rep: Rep, correction: string | null): Promise<ComposeOut | string | { capped: string }> {
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: userPrompt(input, rep) }];
  if (correction) messages.push({ role: "user", content: correction });

  try {
    // Timeouts, the retry on an overloaded or dropped call, and the schema
    // check all live in the shared client: a rep at a stop should not get
    // "not written" for a blip, nor a draft built from a malformed reply.
    const { data } = await ai({
      task: "outbound_compose",
      system: { cached: systemPrompt(rep) },
      messages,
      schema: ComposeSchema,
    });
    return data;
  } catch (err) {
    if (isAiCap(err)) return { capped: err.message };
    return err instanceof Error ? err.message.replace(/\.$/, "").toLowerCase() : String(err);
  }
}

/**
 * Compose one ask, or come back with the reason it was not composed.
 *
 * Never throws. A missing key, a model error and a refused grounding check
 * all land in the same place: an unwritten row that states the ask. Filing
 * an account's outreach must not fail because an email could not be written
 * from it.
 */
export async function composeAsk(input: ComposeAskInput): Promise<ComposedAsk> {
  if (!aiConfigured()) return { written: false, reason: "Not written: no model is configured on this deployment." };
  const rep = input.rep ?? (await currentRep());

  const sources = [input.ask, input.noteText, input.account.name, input.account.city ?? "", TALKING_POINT_TEXT];
  const firstNames = input.contacts.map((c) => c.name.split(/\s+/)[0]).filter(Boolean);

  let correction: string | null = null;
  // Two attempts at most: the first, and one correction when what was wrong
  // was the writing rather than the facts.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const out = await askModel(input, rep, correction);
    if (typeof out === "string") return { written: false, reason: `Not written: ${out}.` };
    if ("capped" in out) return { written: false, reason: `Not written. ${out.capped}` };

    if (!out.writable || !out.body.trim() || !out.subject.trim()) {
      return {
        written: false,
        reason: out.reason?.trim() || "Not written: there is nothing to send on this one yet.",
      };
    }

    const invented = fabricationFailure(out.subject, out.body, sources, firstNames);
    if (invented) return { written: false, reason: `Not written: ${invented}.` };

    const style = styleFailure(out.subject, out.body, sources);
    if (style) {
      if (attempt === 0) {
        correction = `That draft was refused before ${rep.first} saw it, because ${style}. Write it again. Change only the writing: every fact in it is already settled by the note, and you may not add a new one to fill the gap. Cut the empty sentence rather than rephrasing it, and if what is left is two sentences, two sentences is the email.`;
        continue;
      }
      return { written: false, reason: `Not written: ${style}.` };
    }

    // The person greeted is the person it goes to. A pick that greets one
    // name and addresses another contact on file is corrected to the one
    // greeted, or to no named contact when the greeted one is not on file.
    const greeted = out.body.match(/^\s*(?:hi|hello|hey|hola)\s+([^\s,&/]+)/i)?.[1]?.toLowerCase() ?? null;
    const firstOf = (c: AskContact) => c.name.split(/\s+/)[0].toLowerCase();
    let contact = input.contacts.find((c) => c.id === out.contact_id) ?? null;
    let greetedOffFile: string | null = null;
    if (greeted && contact && firstOf(contact) !== greeted) {
      contact = input.contacts.find((c) => firstOf(c) === greeted) ?? null;
      if (!contact) greetedOffFile = greeted.charAt(0).toUpperCase() + greeted.slice(1);
    }
    // One address written in the note itself outranks the store's general one.
    const noteEmails = [...new Set((input.noteText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []).map((e) => e.toLowerCase()))];
    const noteEmail = noteEmails.length === 1 ? noteEmails[0] : null;
    return {
      written: true,
      subject: out.subject.trim(),
      body: out.body.trim(),
      contactId: contact?.id ?? null,
      toName: contact?.name ?? greetedOffFile,
      toEmail: contact?.email ?? noteEmail ?? input.account.email ?? null,
    };
  }

  return { written: false, reason: "Not written: the draft could not be written in his voice." };
}

/**
 * The body of a row that could not be written: the ask as Juan said it, then
 * the reason, in that order. The ask leads because the ask is the fact, and
 * the fact is what he is deciding about.
 */
export function unwrittenBody(ask: string, reason: string): string {
  return `${ask.trim()}\n\n${reason.trim()}`;
}

/** play_key for a row composed from a customer ask, and for one that stayed
 *  unwritten. Rendered as-is on the Outbound card, underscores to spaces, so
 *  a row says which of the two it is without a second glance. */
export const ASK_COMPOSED_PLAY = "customer_ask";
export const ASK_UNWRITTEN_PLAY = "unwritten_ask";
