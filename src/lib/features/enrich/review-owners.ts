/**
 * Tier 3a: a customer's review that prints a person's name beside an owner or
 * manager word. The sentence is kept verbatim as the claim. A name with no
 * role word beside it is not a finding. Port of headhunter_reviews.py's pure
 * half. No imports, so it runs under plain node in the tests.
 */
export type ReviewMention = { name: string; role: string; sentence: string };
export type ReviewOwner = { name: string; role: string; mentions: number; sentence: string };
export type RawReview = { text?: { text?: string } | null; originalText?: { text?: string } | null; authorAttribution?: { displayName?: string } | null };

// JS has no scoped (?i:...) on every runtime, so the words that may be any
// case are spelled out as [Oo][Ww]... and the name tokens stay case-sensitive.
const ci = (w: string) => w.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`).replace(/ /g, "\\s+");
const alt = (words: string[]) => words.map(ci).join("|");
const ROLE = alt(["co-owner", "co owner", "owner", "co-founder", "founder", "proprietor", "general manager", "store manager", "manager", "operator", "director"]);
const TOKEN = "[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?";
const NAME = `(?:Dr\\.?\\s+)?${TOKEN}(?:\\s+${TOKEN}){0,2}`;
const FILLER =
  `(?:,\\s*|\\s*\\(\\s*|\\s*-\\s*|\\s+)?(?:(?:${alt(["he", "she", "they"])})\\s+(?:${alt(["is", "was"])})\\s+)?(?:(?:${alt(["who is", "is", "was"])})\\s+)?(?:(?:${alt(["the", "our", "its", "a", "an"])})\\s+)?(?:(?:${alt(["amazing", "wonderful", "friendly", "lovely"])})\\s+)?`;
const NAME_THEN_ROLE = new RegExp(`\\b(${NAME})${FILLER}(${ROLE})\\b`, "g");
const ROLE_THEN_NAME = new RegExp(`\\b(${ROLE})(?:\\s*(?:(?:${alt(["is", "named"])})\\s+|,\\s*|-\\s*)?)(${NAME})\\b`, "g");

const NOT_NAME = new Set(("the our this that his her their its they she he we owner manager founder and but also great amazing very super store shop staff place everyone everything thank thanks love highly definitely best good nice friendly helpful knowledgeable customer service products product vitamin vitamins health natural market foods food clinic center office google yelp in at on of for to is was are as if when after before so my your a an new old previous former current not no yes call ask speak talk tell see meet contact email shout big huge special please recommend visit try go").split(" "));

export function sentences(text: string): string[] {
  return (text || "").split(/(?<!\bDr\.)(?<!\bMr\.)(?<!\bMs\.)(?<!\bMrs\.)(?<=[.!?\n])\s+/).map((s) => s.trim()).filter(Boolean);
}

function cleanName(raw: string): string | null {
  let parts = raw.split(/\s+/);
  if (parts[0] && parts[0].toLowerCase().replace(/\.$/, "") === "dr") parts = parts.slice(1);
  if (!parts.length || parts.some((p) => NOT_NAME.has(p.toLowerCase()))) return null;
  return parts.join(" ");
}

const isProperName = (s: string) => new RegExp(`^${NAME}$`).test(s);

export function mentionsInReview(text: string): ReviewMention[] {
  const out: ReviewMention[] = [];
  for (const sent of sentences(text)) {
    const specs: [RegExp, number, number][] = [[NAME_THEN_ROLE, 1, 2], [ROLE_THEN_NAME, 2, 1]];
    for (const [rx, nameIdx, roleIdx] of specs) {
      rx.lastIndex = 0;
      for (let m = rx.exec(sent); m; m = rx.exec(sent)) {
        if (!isProperName(m[nameIdx])) continue;
        const name = cleanName(m[nameIdx]);
        if (!name) continue;
        const window = sent.slice(Math.max(0, m.index - 40), m.index + m[0].length + 10).toLowerCase();
        if (/\b(?:former|previous|ex-|used to be|not the|sold)\b/.test(window)) continue;
        out.push({ name, role: m[roleIdx].trim().toLowerCase().replace(/\s+/g, " "), sentence: sent.slice(0, 300) });
      }
    }
  }
  return out;
}

export function distillReviews(reviews: RawReview[]): ReviewOwner[] {
  type Acc = { name: string; roles: Map<string, number>; sentences: string[] };
  const people = new Map<string, Acc>();
  for (const rv of reviews) {
    const text = rv.text?.text || rv.originalText?.text || "";
    const author = (rv.authorAttribution?.displayName || "").toLowerCase();
    for (const hit of mentionsInReview(text)) {
      if (hit.name.toLowerCase() === author) continue;
      const key = hit.name.toLowerCase();
      const p: Acc = people.get(key) ?? { name: hit.name, roles: new Map<string, number>(), sentences: [] };
      p.roles.set(hit.role, (p.roles.get(hit.role) ?? 0) + 1);
      p.sentences.push(hit.sentence);
      people.set(key, p);
    }
  }
  return [...people.values()]
    .map((p) => ({
      name: p.name,
      role: [...p.roles.entries()].sort((a, b) => b[1] - a[1])[0][0],
      mentions: p.sentences.length,
      sentence: p.sentences[0],
    }))
    .sort((a, b) => b.mentions - a.mentions);
}
