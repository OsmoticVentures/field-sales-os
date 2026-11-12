/**
 * The two short lines a Prospect call card carries instead of scores and
 * hours: why I am calling, and what they buy or when we last touched.
 *
 * Pure, so it is testable and the same wording renders anywhere. Every word
 * comes from the queue row's own notes or the account's orders and
 * activities; nothing is added. A missing piece renders absent.
 */

const DAYS: [RegExp, string][] = [
  [/\bmon(day)?\b/i, "Mon"],
  [/\btue(s|sday)?\b/i, "Tue"],
  [/\bwed(nesday)?\b/i, "Wed"],
  [/\bthu(r|rs|rsday)?\b/i, "Thu"],
  [/\bfri(day)?\b/i, "Fri"],
  [/\bsat(urday)?\b/i, "Sat"],
  [/\bsun(day)?\b/i, "Sun"],
];

/** Sentences that open with what to do, as the queue writers phrase them. */
const ACTION = /^(set|call|ask|confirm|visit|pitch|follow|send|check|book|schedule|get|find|offer|bring|drop|introduce|present|reorder|remind|text|email|talk|see|meet)\b/i;

function daysIn(s: string): string[] {
  const hits: { at: number; day: string }[] = [];
  for (const [re, day] of DAYS) {
    const m = s.match(re);
    if (m && m.index !== undefined) hits.push({ at: m.index, day });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.day);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[.\s]+$/, "").trim();
}

/** "Set an appointment for Wed 11/4." -> "Set up Wed". A task copied from
 *  a log ("Stated in the log: NAME: Call Charles with pricing · ...") keeps
 *  only the task. Otherwise the first sentence that says what to do. */
export function callReason(notes: string | null | undefined, lastOrderAt: string | null = null, now = new Date()): string | null {
  const lapsed = lastOrderAt ? lastOrderAt.slice(0, 10) < new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10) : false;
  if (!notes || !notes.trim()) return lapsed ? "Win back" : null;
  let text = notes.trim();

  // "Visit Thu 11/19. Set the appointment with Letty." The planned visit
  // day leads, then the first thing the call is for.
  const plan = text.match(/^Visit\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\/\d{1,2})\.\s*([^\n]*)/i);
  if (plan) {
    const purpose = clean(plan[2].split(/(?<=[.!?])\s+/)[0] ?? "");
    return purpose ? `Visit ${plan[1]} · ${cap(purpose)}` : `Visit ${plan[1]}`;
  }

  const logged = text.match(/^Stated in the log:\s*[^:]+:\s*([^·]+)/i);
  if (logged) text = logged[1];

  const sentences = text
    .split(/(?<!\b(?:Dr|Mr|Mrs|Ms|St|Inc|Co|vs)\.)(?<=[.!?])\s+|\s+·\s+/)
    .map((s) => clean(s.replace(/^(dormant|note|todo|next step)\s*:\s*/i, "")))
    .filter((s) => Boolean(s) && !/^HQ list\b/i.test(s));

  // Setting an appointment is most of the queue: say only the day(s).
  const appt = sentences.find((s) => /\b(appointment|set up)\b/i.test(s) && daysIn(s).length > 0);
  if (appt) {
    const days = daysIn(appt).slice(0, 2);
    return `Set up ${days.join("-")}`;
  }

  const action = sentences.find((s) => ACTION.test(s));
  if (action) return cap(action);

  // "Customers ask for GSC; he is a Shaklee distributor, so pitch what fits
  // beside it." The clause alone loses its subject, so keep the sentence.
  const advice = sentences.find((s) => /\b(pitch|ask|offer|confirm|call)\b/i.test(s));
  if (advice) return cap(advice);
  return lapsed ? "Win back" : null;
}

/** "GSE Liquid Concentrate 2 oz." -> "GSE Liquid Concentrate". */
export function shortProduct(name: string): string {
  const base = name.replace(/,?\s*\d+(\.\d+)?\s*(fl\.?\s*)?(oz|ml|mg|mcg|g|ct|count|caps|tabs|tablets|capsules|lb)\.?(?=\W|$).*$/i, "");
  // "Electro-C, Cherry" / "Coconut Oil Soap, Unscented": the variant goes.
  return clean(base.split(",")[0]);
}

const TOUCH_VERB: Record<string, string> = {
  call: "Called",
  meeting: "Met",
  visit: "Visited",
  email_out: "Emailed",
  email_in: "Heard back",
  sms_out: "Texted",
  text: "Texted",
};

function monthYear(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function monthDay(iso: string, now: Date): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "America/Los_Angeles" });
}

export type CallContextInput = {
  /** Product names ranked by units, most first, literature already removed. */
  topProducts: string[];
  lastOrderAt: string | null;
  lastTouch: { at: string; kind: string } | null;
};

/** "Buys GSE Liquid Concentrate, Ear Drops · Met Oct 28". An account that
 *  stopped ordering over a year ago reads "Last order May 2020". */
export function buyingLine(c: CallContextInput, now = new Date()): string | null {
  const parts: string[] = [];
  const yearAgo = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  const lapsed = c.lastOrderAt ? c.lastOrderAt.slice(0, 10) < yearAgo : false;
  const products = [...new Set(c.topProducts.map(shortProduct))].slice(0, 2);

  if (products.length > 0 && !lapsed) parts.push(`Buys ${products.join(", ")}`);
  else if (products.length > 0 && c.lastOrderAt) parts.push(`Bought ${products.join(", ")}, ${monthYear(c.lastOrderAt)}`);
  else if (c.lastOrderAt) parts.push(`Last order ${monthYear(c.lastOrderAt)}`);

  if (c.lastTouch) {
    const verb = TOUCH_VERB[c.lastTouch.kind];
    if (verb) parts.push(`${verb} ${monthDay(c.lastTouch.at, now)}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
