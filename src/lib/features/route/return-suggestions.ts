/**
 * Suggested returns: accounts whose visit in the last 60 days went well and
 * that need a revisit for a stated purpose or time (Juan, 2026-09-28). Ported from the NutriBiotic OS's
 * lib/return-suggestions.ts (2026-09-25). Only a stated "come back",
 * already queued in nb_directives, ever puts an account here: not a score,
 * not the reorder cycle.
 *
 * A directive is offered only when it clears worthOffering below: not a
 * low-grade or closing account, a positive recent visit, a purpose beyond
 * logistics, and not already past its own "today"/"tomorrow".
 *
 * A directive with a stated date inside the coming 7 days is a suggestion
 * for that exact date, always shown there, uncapped. One with no stated date
 * is backlog: it spreads across the week oldest-first, 4 suggestions a day
 * at most. A stated date past the week waits until the horizon reaches it.
 */
import { planningHorizonDates } from "./field-week";
import type { ReturnContext, ReturnDirective } from "./dal";

/** The next step the note names: a desk touch (SDR) or a stop on a route. */
export type ReturnStep = "call" | "email" | "text" | "visit";

export type ReturnSuggestion = {
  accountId: string;
  /** The extractor's own title/notes wording, never a template sentence. */
  reason: string;
  /** Read from the note's own wording, then its follow-up tag. */
  step: ReturnStep;
  /** One line led by the step: the title re-worded, nothing added. */
  premise: string;
  /** The note's extra line or quote, only when it says something the
   *  premise doesn't; null otherwise. */
  detail: string | null;
  /** Verbatim clause from the note stating the ask; null when it had none. */
  quote: string | null;
  /** RFC3339, only when the note stated one. */
  statedTime: string | null;
  /** YYYY-MM-DD, the day this suggestion is for. */
  suggestedDate: string;
  directiveId: string;
  /** When Juan said it (the directive's created_at). */
  loggedAt: string;
};

function parseFollowUp(directive: string): {
  tag: string;
  name: string | null;
  title: string;
  statedTimeIso: string | null;
  extra: string | null;
  quote: string | null;
} {
  const tag = directive.match(/^\[follow-up:([a-z]+)\]/)?.[1] ?? "";
  const withoutTag = directive.replace(/^\[follow-up:[a-z]+\]\s*/, "");
  const parts = withoutTag.split(" · ");
  const first = parts[0] ?? withoutTag;
  const colon = first.indexOf(": ");
  const name = colon > -1 ? first.slice(0, colon) : null;
  const title = colon > -1 ? first.slice(colon + 2) : first;
  const timePart = parts.find((p) => p.startsWith("Stated time: "));
  const statedTimeIso = timePart ? timePart.slice("Stated time: ".length) : null;
  const quotePart = parts.find((p) => p.startsWith('Quote: "') && p.endsWith('"'));
  const quote = quotePart ? quotePart.slice('Quote: "'.length, -1) : null;
  const extra =
    parts
      .slice(1)
      .filter((p) => p !== "No time stated" && !p.startsWith("Stated time:") && !p.startsWith("Stated duration:") && !p.startsWith("Quote:"))
      .join(". ") || null;
  return { tag, name, title, statedTimeIso, extra, quote };
}

// ---------------------------------------------------------------------------
// Step and premise. Deterministic, no model: the step is read from the
// note's own verbs, the premise is the note's title re-worded around it.
// ---------------------------------------------------------------------------

const LEAD: Record<ReturnStep, RegExp> = {
  call: /^(?:call|phone|give (?:her|him|them) a call)\b\s*/i,
  email: /^e-?mail\b\s*/i,
  text: /^text\b\s*/i,
  visit: /^(?:(?:return|follow-up|follow up) visit(?: to)?|visit|stop by|drop by|go (?:back )?to|meeting(?: with)?|meet with)\b\s*/i,
};
const STEP_WORD: Record<ReturnStep, string> = { call: "Call", email: "Email", text: "Text", visit: "Visit" };
const IMPERATIVE = /^(?:follow|ask|set|get|confirm|check|send|schedule|see|discuss|bring|drop|pick|show|review|present|share|introduce|find|talk|touch|update|deliver|offer|pitch|place|take|remind|thank|book|go|say|leave|catch|reach|request|tell|walk)\b/i;

/** The step the note names. The title's own lead verb first, then the first
 *  channel named anywhere in the note, then the follow-up tag; a bare
 *  reminder with no channel is a call, the pattern most of them carry. */
export function readStep(tag: string, title: string, extra: string | null, quote: string | null): ReturnStep {
  for (const step of ["call", "email", "text", "visit"] as const) if (LEAD[step].test(title)) return step;
  const find = (text: string): ReturnStep | null => {
    const hits: [number, ReturnStep][] = [];
    const probe = (re: RegExp, step: ReturnStep) => {
      const i = text.search(re);
      if (i > -1) hits.push([i, step]);
    };
    probe(/\b(?:over|by|via) e-?mail\b|\be-?mail\b/i, "email");
    probe(/\btext(?:ed)?\b/i, "text");
    probe(/\bcall(?:s|ed|ing)?\b|\bphone\b/i, "call");
    probe(/\bvisit\b|\bstop by\b|\bcome (?:back|by|to)\b|\boffice\b|\bin person\b|\bmeeting\b/i, "visit");
    hits.sort((a, b) => a[0] - b[0]);
    return hits[0]?.[1] ?? null;
  };
  const fromTitle = find(title);
  if (fromTitle) return fromTitle;
  if (tag === "visit" || tag === "meeting") return "visit";
  return find([extra, quote].filter(Boolean).join(" ")) ?? "call";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Spellings of the account's name a title might use: the whole name, its
 *  parts split on ",", "-", "&", "/", "(", and the first two words of a
 *  longer name ("AMITY Wellness"), longest first. Spaces match hyphens. */
function nameForms(name: string): string[] {
  const parts = name.split(/,|\s+[-&]\s+|\/|\(/).map((p) => p.replace(/\)/g, "").trim());
  const words = name.trim().split(/\s+/);
  const firstTwo = words.length >= 3 ? words.slice(0, 2).join(" ") : "";
  return [...new Set([name.trim(), ...parts, firstTwo])].filter((f) => f.length >= 8 || (f.length >= 4 && f !== firstTwo)).sort((a, b) => b.length - a.length);
}

/** Takes the account's own name out of a title (the card already shows it),
 *  plus the preposition that pointed at it and any capitalized tail of a
 *  longer official name ("One More Rep Sports Performance"). */
function withoutName(title: string, name: string | null): string {
  if (!name) return title;
  let out = title;
  for (const form of nameForms(name)) {
    const body = escapeRe(form).replace(/\\-|\s+/g, "[\\s-]+");
    const hit = new RegExp(`\\s*\\b(?:(?:at|to|with|from|for)\\s+)?(?:the\\s+)?${body}(?:'s)?(?![\\w])`, "i").exec(out);
    if (!hit) continue;
    // Case-sensitive on purpose: only Capitalized words continue a name.
    const tail = /^(?:\s+[A-Z][\w'&-]*)*/.exec(out.slice(hit.index + hit[0].length))?.[0] ?? "";
    out = `${out.slice(0, hit.index)} ${out.slice(hit.index + hit[0].length + tail.length)}`;
    break;
  }
  // An acronym name ("NHC GROUP") is often written as the acronym alone.
  const acronym = name.match(/^([A-Z]{2,5})\b/)?.[1];
  if (acronym) out = out.replace(new RegExp(`\\s*\\b(?:(?:at|to|with)\\s+)?${acronym}\\b`), " ");
  return out
    .replace(/\(\s*\)/g, "")
    .replace(/\(([^)]*)\)/g, "$1")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+(?:at|to|with|from|for)\s*$/i, "")
    .replace(/^\s*[-,]\s*|\s*[-,]\s*$/g, "")
    .trim();
}

const CHANNEL_PHRASE: Record<ReturnStep, RegExp | null> = {
  call: /\s+(?:over|by|via) (?:the )?phone\b/i,
  email: /\s+(?:over|by|via) e-?mail\b/i,
  text: /\s+(?:over|by|via) text\b/i,
  visit: /\s+in person\b/i,
};

/** "Call to confirm meeting", "Visit to say hi and check on space for
 *  community product", "Email to follow up with Kathy": the step's verb leads,
 *  the rest is the title's own words. */
export function premiseFor(step: ReturnStep, title: string, name: string | null): string {
  const word = STEP_WORD[step];
  let rest = withoutName(title, name);
  const channel = CHANNEL_PHRASE[step];
  if (channel) rest = rest.replace(channel, "").trim();
  // "Send Ghina Broghan email with ..." reads "Email Ghina Broghan with ...";
  // "Send credit card email ..." already names its channel, so it stands.
  if ((step === "email" || step === "text") && /^send\b/i.test(rest)) {
    const noun = step === "email" ? "(?:an?\\s+)?e-?mail" : "(?:a\\s+)?text(?:\\s+message)?";
    const toPerson = new RegExp(`^[Ss]end\\s+((?:[A-Z][\\w'-]*\\s+)+)${noun}\\b\\s*`).exec(rest);
    if (toPerson) return `${word} ${toPerson[1]}${rest.slice(toPerson[0].length)}`.trim();
    return `${rest[0].toUpperCase()}${rest.slice(1)}`;
  }
  if (LEAD[step].test(rest)) {
    rest = rest.replace(LEAD[step], "").replace(/^re:\s*/i, "about ").trim();
    return rest ? `${word} ${rest}` : word;
  }
  if (!rest) return word;
  if (IMPERATIVE.test(rest) && !/^[A-Z]{2}/.test(rest)) return `${word} to ${rest[0].toLowerCase()}${rest.slice(1)}`;
  return `${word}: ${rest[0].toUpperCase()}${rest.slice(1)}`;
}

const STOP = new Set(
  ("the a an and or but to of in on at for with from by as is it its be was were are this that then than so if her him his them " +
    "they she he i me my we our you your up out over about after before day just not no do did will would should can could").split(" "),
);
function contentWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => w.replace(/(?:ing|ed|s)$/, "")),
  );
}

/** The extra line or quote, only when most of its words are new beyond what
 *  is already on the card, so the card never says one thing twice. */
export function detailFor(premise: string, extra: string | null, quote: string | null): string | null {
  const said = contentWords(premise);
  for (const candidate of [extra, quote]) {
    if (!candidate) continue;
    const words = [...contentWords(candidate)];
    if (words.length === 0) continue;
    const fresh = words.filter((w) => !said.has(w)).length / words.length;
    if (fresh > 0.5) {
      const text = candidate.trim().replace(/\.$/, "");
      return `${text[0].toUpperCase()}${text.slice(1)}`;
    }
    for (const w of words) said.add(w);
  }
  return null;
}

const BELOW_C = new Set(["D", "E", "F", "G"]);
const GOOD_OUTCOMES = new Set(["left_sample", "reached", "interested", "meeting_set"]);
const POSITIVE = /\b(likes?|liked|loves?|interested|interest|excited|warm|great|ready to buy|would buy|wants?|try|trying|soft[- ]clos\w*|good fit|perfect fit|solid fit|potential|opening meeting)\b/i;
const LOGISTICS_ONLY = /\b(closed|call ahead|call (the )?\w+( \w+)? before|before (returning|trying|coming)|hours|no answer)\b/i;
const GENERIC_TITLE = /^(follow[- ]up|return)( visit)? (to|at) (?!.*\b(if|about|with|for|see|check)\b)/i;
const SAME_DAY = /\b(today|tonight|tomorrow)\b/i;

/** True when the account had a visit or meeting in the last 60 days that
 *  went well: a sample left, a reached buyer, or a positive line in the note. */
function wentWell(ctx: ReturnContext): boolean {
  return ctx.notes.some(
    (n) =>
      (n.kind === "visit" || n.kind === "meeting") &&
      ((n.outcome !== null && GOOD_OUTCOMES.has(n.outcome)) || (n.detail !== null && POSITIVE.test(n.detail))),
  );
}

/** Deterministic gate, no model: every clause reads a logged field. */
function worthOffering(d: ReturnDirective, parsed: { title: string; statedTimeIso: string | null; extra: string | null }, ctx: ReturnContext | undefined): boolean {
  if (!ctx) return false;
  if (ctx.tier && BELOW_C.has(ctx.tier)) return false;
  if (ctx.leadStage === "closed" || ctx.leadStatus === "Closed") return false;
  if (!wentWell(ctx)) return false;
  const text = [parsed.title, parsed.extra].filter(Boolean).join(". ");
  if (LOGISTICS_ONLY.test(text)) return false;
  // A bare "Return visit to X" names no purpose; a vague window doesn't either.
  if (!parsed.statedTimeIso && GENERIC_TITLE.test(parsed.title)) return false;
  // "Today" / "tomorrow" in a note is spent two days later.
  if (!parsed.statedTimeIso && SAME_DAY.test(text) && Date.now() - new Date(d.created_at).getTime() > 2 * 86_400_000) return false;
  return true;
}

/** `bookIds`: Juan's ranked book. A directive on an account outside it
 *  (another rep's, or closed) is not offered here. */
export function buildReturnSuggestions(bookIds: Set<string>, directives: ReturnDirective[], context: Map<string, ReturnContext>): ReturnSuggestion[] {
  const week = planningHorizonDates(7);
  const weekSet = new Set(week);

  const seen = new Set<string>();
  type Parsed = ReturnType<typeof parseFollowUp>;
  const dated: { directive: ReturnDirective; parsed: Parsed; date: string }[] = [];
  const backlog: { directive: ReturnDirective; parsed: Parsed }[] = [];

  // Newest first, so an account's latest ask wins over a stale one.
  for (const d of [...directives].reverse()) {
    if (seen.has(d.account_id) || !bookIds.has(d.account_id)) continue;
    const parsed = parseFollowUp(d.directive);
    if (!worthOffering(d, parsed, context.get(d.account_id))) continue;
    const statedDate = parsed.statedTimeIso ? parsed.statedTimeIso.slice(0, 10) : null;
    if (statedDate && !weekSet.has(statedDate)) continue;
    seen.add(d.account_id);
    if (statedDate) dated.push({ directive: d, parsed, date: statedDate });
    else backlog.push({ directive: d, parsed });
  }

  const toSuggestion = (directive: ReturnDirective, parsed: Parsed, date: string): ReturnSuggestion => {
    const step = readStep(parsed.tag, parsed.title, parsed.extra, parsed.quote);
    const premise = premiseFor(step, parsed.title, parsed.name);
    return {
      accountId: directive.account_id,
      reason: [parsed.title, parsed.extra].filter(Boolean).join(". "),
      step,
      premise,
      detail: detailFor(premise, parsed.extra, parsed.quote),
      quote: parsed.quote,
      statedTime: parsed.statedTimeIso,
      suggestedDate: date,
      directiveId: directive.id,
      loggedAt: directive.created_at,
    };
  };

  const capacity = new Map(week.map((d) => [d, 4]));
  const out: ReturnSuggestion[] = [];

  for (const { directive, parsed, date } of dated) {
    out.push(toSuggestion(directive, parsed, date));
    capacity.set(date, (capacity.get(date) ?? 4) - 1);
  }

  const byAge = [...backlog].sort((a, b) => new Date(a.directive.created_at).getTime() - new Date(b.directive.created_at).getTime());
  for (const { directive, parsed } of byAge) {
    const day = week.find((d) => (capacity.get(d) ?? 0) > 0);
    if (!day) break;
    out.push(toSuggestion(directive, parsed, day));
    capacity.set(day, (capacity.get(day) ?? 0) - 1);
  }

  return out;
}
