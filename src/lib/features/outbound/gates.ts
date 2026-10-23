/**
 * The pure checks every draft passes before it is filed: one ask per row
 * (asksCollide) and the grounding gates (fabrication, style, specificity).
 * No server imports, so nutribiotic/tests/style_parity.py runs the real
 * styleFailure under plain node.
 */

import {
  BANNED,
  BODY_LIMIT,
  BODY_LIMIT_WHY,
  FILLER,
  FILLER_WHY,
  SIGNATURE_BLOCK,
  SIGNATURE_TAIL_LINES,
  SIGNATURE_WHY,
} from "./email-style-rules.generated.ts";

/** A typed-out block for either rep ("Kyle Maxwell", "Juan Arenas"): the mail client adds it. */
const REP_BLOCK = /^\s*(kyle\s+maxwell[\w\s.]{0,20})\s*$/i;

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
    if (!last || /^(juan|kyle|thanks|thank you|talk soon|best|regards)[,.]?$/i.test(last) || SIGNATURE_BLOCK.test(last)) {
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
    if (SIGNATURE_BLOCK.test(line) || REP_BLOCK.test(line)) return `the draft used ${SIGNATURE_WHY}`;
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
