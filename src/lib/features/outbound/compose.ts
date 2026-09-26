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
import Anthropic from "@anthropic-ai/sdk";
import { EMAIL_VOICE } from "./email-voice.generated";
import { TALKING_POINTS } from "./talking-points.generated";
import {
  BANNED,
  BODY_LIMIT,
  BODY_LIMIT_WHY,
  FILLER,
  FILLER_WHY,
  SIGNATURE_BLOCK,
  SIGNATURE_TAIL_LINES,
  SIGNATURE_WHY,
} from "./email-style-rules.generated";

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
};

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
// Dedup. Two asks about one conversation must produce one row.
// ---------------------------------------------------------------------------

/** Contractions, expanded so "She's giving me an order" and "She is giving me
 *  an order." are the same string. */
const CONTRACTIONS: [RegExp, string][] = [
  [/\bit's\b/g, "it is"],
  [/\bshe's\b/g, "she is"],
  [/\bhe's\b/g, "he is"],
  [/\bthat's\b/g, "that is"],
  [/\bthere's\b/g, "there is"],
  [/\bwho's\b/g, "who is"],
  [/\bwhat's\b/g, "what is"],
  [/\bthey're\b/g, "they are"],
  [/\bwe're\b/g, "we are"],
  [/\byou're\b/g, "you are"],
  [/\bi'm\b/g, "i am"],
  [/\bdon't\b/g, "do not"],
  [/\bdoesn't\b/g, "does not"],
  [/\bdidn't\b/g, "did not"],
  [/\bcan't\b/g, "cannot"],
  [/\bwon't\b/g, "will not"],
  [/\bwouldn't\b/g, "would not"],
  [/\bisn't\b/g, "is not"],
  [/\baren't\b/g, "are not"],
  [/\bwasn't\b/g, "was not"],
  [/\bi'll\b/g, "i will"],
  [/\bwe'll\b/g, "we will"],
  [/\bthey'll\b/g, "they will"],
  [/\bi've\b/g, "i have"],
  [/\bwe've\b/g, "we have"],
  [/\bthey've\b/g, "they have"],
];

/** Words that carry no meaning for "is this the same ask". Kept short on
 *  purpose: an over-eager stoplist collapses two different asks into one. */
const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "with", "on", "in", "at", "by", "from",
  "is", "are", "was", "were", "be", "been", "as", "that", "this", "it", "its",
  "he", "she", "they", "them", "him", "her", "his", "their", "we", "us", "our", "i", "me", "my",
  "asked", "asks", "ask", "asking", "wants", "want", "wanted", "would", "will", "like",
  "some", "any", "about", "also", "please", "said", "says", "me",
]);

export function normalizeAsk(ask: string): string {
  let s = ask.toLowerCase().replace(/[‘’ʼ]/g, "'");
  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);
  return s
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function contentTokens(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((t) => t && !STOPWORDS.has(t)));
}

/**
 * Is this the same ask, said twice?
 *
 * Equal after normalizing, or one ask's content words are entirely contained
 * in the other's. Two content words are required before containment counts,
 * so a bare "the catalog" does not swallow every ask that happens to mention
 * a catalog.
 */
export function asksCollide(a: string, b: string): boolean {
  const na = normalizeAsk(a);
  const nb = normalizeAsk(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const ta = contentTokens(na);
  const tb = contentTokens(nb);
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  if (small.size < 2) return false;
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The grounding gate. Deterministic, and it has the last word.
// ---------------------------------------------------------------------------

/**
 * Everything the composed text is allowed to know, flattened. A number that is
 * not in here was not stated by anyone.
 */
function digitRuns(text: string): string[] {
  return text.match(/\d+/g) ?? [];
}

/**
 * Words that appear in every follow-up ever written and so prove nothing
 * about WHICH account this one is for. Separate from STOPWORDS above, which
 * exists to decide whether two asks are the same ask.
 */
const UNSPECIFIC = new Set([
  "email", "emails", "emailed", "call", "called", "visit", "visited", "note", "notes",
  "follow", "following", "followup", "back", "next", "step", "steps", "time", "times",
  "info", "information", "detail", "details", "send", "sent", "sending", "give", "given",
  "want", "wants", "wanted", "need", "needs", "needed", "thing", "things", "today",
  "tomorrow", "week", "weeks", "month", "months", "said", "says", "talk", "talked",
  "spoke", "speak", "asked", "asking", "interested", "starting", "start", "started",
  "would", "could", "should", "there", "their", "them", "they", "your", "yours",
  "here", "have", "with", "that", "this", "from", "about", "when", "what", "will",
]);

/** Singular and plural read as the same word, so "samples" in the note matches
 *  "sample" in the draft. */
function stem(word: string): string {
  return word.endsWith("s") && word.length > 4 ? word.slice(0, -1) : word;
}

function distinctive(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+]+/)) {
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw) || UNSPECIFIC.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/** The email minus its frame: no greeting line, no sign-off. What is left is
 *  what the recipient is actually being told. */
function bodyWithoutFrame(body: string): string {
  const lines = body.split("\n");
  while (lines.length && (!lines[0].trim() || /^\s*(hi|hello|hey|hola|buenos)\b/i.test(lines[0]))) lines.shift();
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (!last || /^(juan|thanks|thank you|talk soon|best|regards)[,.]?$/i.test(last) || SIGNATURE_BLOCK.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join("\n");
}

/**
 * Does this email tell the recipient anything about their own account?
 *
 * A floor, not a quality judgement: a draft that shares nothing with the
 * note it came from is a template with a name pasted into it.
 */
export function specificityFailure(body: string, sources: string[]): string | null {
  const said = distinctive(sources.join(" \n "));
  if (said.size < 2) return null; // The note itself said nothing specific; not the draft's fault.
  const written = distinctive(bodyWithoutFrame(body));
  let shared = 0;
  for (const w of written) if (said.has(w)) shared += 1;
  return shared >= 2 ? null : "the draft never names anything from the note, so it would read the same for any account";
}

/**
 * A fact in the draft that nobody stated. NEVER RETRIED.
 *
 * A model that has just invented a price and is told "you invented a price"
 * will hand back a different price. The only safe answer to a fabrication is
 * to stop writing, so this class of failure ends the composition and the
 * row says plainly that it was not written.
 */
export function fabricationFailure(
  subject: string,
  body: string,
  sources: string[],
  allowedFirstNames: string[],
): string | null {
  const text = `${subject}\n${body}`;

  const stated = new Set(digitRuns(sources.join(" \n ")));
  for (const n of digitRuns(text)) {
    if (!stated.has(n)) return `the draft used a number nobody stated (${n})`;
  }

  // The greeting names a person, and that person is on file. A greeting is
  // the first fabrication a reader would notice, and the cheapest one to
  // make. "Hi Honey and Susan," greets everyone he met. Each name must be on
  // file for the account or named in the note itself.
  const greeting = body.match(/^\s*(hi|hello|hey|hola)\b([^,\n]*),/i);
  if (greeting) {
    const named = greeting[2].trim();
    if (named) {
      const allowed = allowedFirstNames.map((n) => n.toLowerCase());
      const sourceText = sources.join(" \n ").toLowerCase();
      for (const person of named.split(/\s*(?:&|\/|,|\band\b|\by\b)\s*/i).filter(Boolean)) {
        const first = person.split(/\s+/)[0].toLowerCase();
        const clean = first.replace(/[^a-zÀ-ɏ]/g, "");
        if (!clean) continue;
        const inNote = new RegExp(`\\b${clean}\\b`).test(sourceText);
        if (!allowed.includes(first) && !inNote) {
          return `the draft greeted "${person}", who is not on file for this account or named in the note`;
        }
      }
    }
  }

  return null;
}

/**
 * A draft that says nothing, or says it in words he does not use. RETRIED
 * ONCE. Unlike a fabrication, this is safe to hand back: the facts are
 * already settled, and what is wrong is the writing.
 */
export function styleFailure(subject: string, body: string, sources: string[]): string | null {
  const text = `${subject}\n${body}`;

  for (const b of BANNED) {
    if (b.re.test(text)) return `the draft used ${b.why}`;
  }

  for (const f of FILLER) {
    const m = text.match(f);
    if (m) return `the draft used ${FILLER_WHY} ("${m[0].trim()}")`;
  }

  // A typed-out signature, looked for only where a signature goes. His mail
  // client adds the block; a draft that carries one sends it twice.
  const tail = body.trimEnd().split("\n").slice(-SIGNATURE_TAIL_LINES);
  for (const line of tail) {
    if (SIGNATURE_BLOCK.test(line)) return `the draft used ${SIGNATURE_WHY}`;
  }

  if (body.length > BODY_LIMIT) return BODY_LIMIT_WHY;

  return specificityFailure(body, sources);
}

/**
 * The reason this composition must be refused, or null when it is clean.
 * Fabrication is asked first: it is the failure that must never reach a
 * customer, and it is the one that ends the attempt rather than correcting
 * it.
 */
export function groundingFailure(
  subject: string,
  body: string,
  sources: string[],
  allowedFirstNames: string[],
): string | null {
  return fabricationFailure(subject, body, sources, allowedFirstNames) ?? styleFailure(subject, body, sources);
}

// ---------------------------------------------------------------------------
// The composition itself.
// ---------------------------------------------------------------------------

const COMPOSE_TOOL = {
  name: "write_outreach_email",
  description:
    "Write the follow-up email for one thing a customer asked for, or report that it cannot be written from what is known.",
  input_schema: {
    type: "object" as const,
    properties: {
      writable: {
        type: "boolean",
        description:
          "true only when the note says enough to write an email the rep could send as-is, and the ask is something HE sends. false when the ask is something the other side will send him, when it is an internal reminder rather than a message, or when writing it would need a fact nobody stated.",
      },
      reason: {
        type: "string",
        description:
          "When writable is false, one plain sentence naming what is missing or why this is not an email he sends, addressed to the rep as 'you'. Empty string when writable is true.",
      },
      contact_id: {
        type: ["string", "null"],
        description:
          "The id of the ONE person this email is addressed to, from the contacts list given. The person who made the ask when the note names them. Null when no listed contact is the right recipient.",
      },
      subject: {
        type: "string",
        description:
          "A short, plain subject naming what this email is about, in sentence case: only proper nouns and product names are capitalized. A noun phrase, never marketing copy, never internal words like 'next step' or 'follow-up action'. Good: 'Chlorella and Defense Plus', 'Order list, per Susan', 'Getting Kim looped in on Clarity+'. Empty string when writable is false.",
      },
      body: {
        type: "string",
        description: "The email, greeting to sign-off. Empty string when writable is false.",
      },
    },
    required: ["writable", "reason", "contact_id", "subject", "body"],
  },
};

function systemPrompt(): string {
  return `You write one short follow-up email for Juan Arenas, NutriBiotic's Southern California field sales rep, from a note he typed after a visit or a call.

YOU MAY ONLY RE-WORD WHAT THE NOTE AND THE ACCOUNT RECORD ALREADY SAY. This is the hardest rule you have. You may re-order it, tighten it, and make it read like an email. You may never introduce a product, a price, a quantity, a date, a discount, a delivery time, a document, or a promise that is not already in the material given to you. If the note does not say when he is coming back, the email does not say when he is coming back. A number that is not in the note is an invention, and an invented number reaches a real customer.

WHAT IS NOT WRITABLE. Say so instead of writing something:
- The ask is something the OTHER side will send or do ("they will quote me", "the owner is expected to email me"). There is nothing for him to send yet.
- The ask is a note to himself, not a message to anyone.
- Writing it would need a fact nobody stated: a price, a sell-through figure, a document that does not exist.
Being honest that it cannot be written is always better than writing something plausible. A vague ask is still writable if he can honestly acknowledge it and say he is putting it together, as long as he promises nothing specific that the note does not already contain.

HOW HE WRITES. What follows is his own voice file, written from his own sent mail, with a real line of his behind every rule. Follow it over any instinct you have about how a sales email is supposed to read. Where it describes a habit, copy the habit, not the example sentence.

${EMAIL_VOICE}

WHAT THIS EMAIL IS FOR. Your habit is to write a report of his visit note. He rewrites every one of those into a pitch: an appointment, or a straight ask for the sale. Most of these are a first email to a store or a clinic, so write it as one unless the note shows he is answering something they sent.

1. Name everyone on their team that the note or the contacts list names, in the first two lines: who connected you, who he met, who he is writing to. "Hi Honey and Susan," / "Following up after meeting with Carmen." / "Miriam told me this address is the way to reach Mehrdad."

2. In a first email, say who he is in one line: "I'm Juan, your representative with NutriBiotic." Not in a reply.

3. Turn account data into the relationship: "Your company has been trusting NutriBiotic for years." Never recite order dates or order history; those are his notes, not their news.

4. Give the reason it helps THEM: helping them sell the products and inform their customers is his job as their rep. "help you sell our products better" / "so your team can better inform customers". Never "go through what is moving and what is not".

5. You may use one or two APPROVED TALKING POINTS (below) when they fit, close to verbatim. They are facts he wrote himself. Nothing else outside the note is a fact.

6. The ask is his to propose, and small. Offer a day or a window rather than asking them to pick one ("Do you have 15 minutes Thursday or Friday morning?", "How is next Monday?"), and use a day or time the note states when it states one. Never write a clock time or a date that is not in the note. When they are ready to buy, the ask is the order itself.

7. Time is relative: "a couple weeks ago", "recently", "two days ago", never the exact date from the note unless it was a day or two ago. Leave out logistics they already know or that go without saying ("with at least a week of notice", "so I am writing here").

8. An attachment is never mentioned alone: say what it is for ("so you can see all products and prices", "helpful to print and show to customers"), and mention one only when the note says he is sending it.

9. Every sentence carries a fact from the note, a talking point, a concrete ask, or a specific kindness about that person. A sentence that would read the same for any account is filler and is refused. "Let me know what other information you need from me to move forward" is refused.

10. Close with appreciation, "Thank you," or "Thanks," ("Gracias," to a Spanish-speaking buyer), then his first name alone, "Juan", on its own line. Never type "Juan Arenas Martin" or a company line: his mail client adds the block.

11. Greet by first name: "Hi Julie,". If no named person fits, open with "Hello,".

A first email runs four to six short paragraphs of one or two sentences each. A reply is shorter.

APPROVED TALKING POINTS:
${TALKING_POINTS.map((t) => `- (${t.topic}) ${t.line}`).join("\n")}`;
}

function userPrompt(input: ComposeAskInput): string {
  const contacts = input.contacts.length
    ? input.contacts
        .map((c) => `${c.id} · ${c.name}${c.title ? `, ${c.title}` : ""}${c.email ? ` · ${c.email}` : " · no email on file"}`)
        .join("\n")
    : "(nobody on file for this account)";

  return `ACCOUNT: ${input.account.name}${input.account.city ? `, ${input.account.city}` : ""}

CONTACTS ON FILE (pick the recipient from these, by id):
${contacts}

THE ASK, in Juan's own words:
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

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

type ComposeOut = {
  writable: boolean;
  reason: string;
  contact_id: string | null;
  subject: string;
  body: string;
};

async function askModel(input: ComposeAskInput, correction: string | null): Promise<ComposeOut | string> {
  const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: userPrompt(input) }];
  if (correction) messages.push({ role: "user", content: correction });

  try {
    const msg = await client!.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 900,
      system: systemPrompt(),
      messages,
      tools: [COMPOSE_TOOL],
      tool_choice: { type: "tool", name: "write_outreach_email" },
    });
    const toolUse = msg.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return "the draft came back empty";
    return toolUse.input as ComposeOut;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
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
  if (!client) return { written: false, reason: "Not written: no model is configured on this deployment." };

  const sources = [input.ask, input.noteText, input.account.name, input.account.city ?? "", TALKING_POINT_TEXT];
  const firstNames = input.contacts.map((c) => c.name.split(/\s+/)[0]).filter(Boolean);

  let correction: string | null = null;
  // Two attempts at most: the first, and one correction when what was wrong
  // was the writing rather than the facts.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const out = await askModel(input, correction);
    if (typeof out === "string") return { written: false, reason: `Not written: ${out}.` };

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
        correction = `That draft was refused before Juan saw it, because ${style}. Write it again. Change only the writing: every fact in it is already settled by the note, and you may not add a new one to fill the gap. Cut the empty sentence rather than rephrasing it, and if what is left is two sentences, two sentences is the email.`;
        continue;
      }
      return { written: false, reason: `Not written: ${style}.` };
    }

    const contact = input.contacts.find((c) => c.id === out.contact_id) ?? null;
    return {
      written: true,
      subject: out.subject.trim(),
      body: out.body.trim(),
      contactId: contact?.id ?? null,
      toName: contact?.name ?? null,
      toEmail: contact?.email ?? input.account.email ?? null,
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
