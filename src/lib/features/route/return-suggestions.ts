/**
 * Suggested returns: accounts worth going back to because Juan said so in a
 * logged field note, call, or visit. Ported from the NutriBiotic OS's
 * lib/return-suggestions.ts (2026-09-25). Only a stated "come back",
 * already queued in nb_directives, ever puts an account here: not a score,
 * not the reorder cycle.
 *
 * A directive with a stated date inside the coming 7 days is a suggestion
 * for that exact date, always shown there, uncapped. One with no stated date
 * is backlog: it spreads across the week oldest-first, 4 suggestions a day
 * at most. A stated date past the week waits until the horizon reaches it.
 */
import { planningHorizonDates } from "./field-week";
import type { ReturnDirective } from "./dal";

export type ReturnSuggestion = {
  accountId: string;
  /** The extractor's own title/notes wording, never a template sentence. */
  reason: string;
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

function parseFollowUp(directive: string): { title: string; statedTimeIso: string | null; extra: string | null; quote: string | null } {
  const withoutTag = directive.replace(/^\[follow-up:[a-z]+\]\s*/, "");
  const parts = withoutTag.split(" · ");
  const first = parts[0] ?? withoutTag;
  const colon = first.indexOf(": ");
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
  return { title, statedTimeIso, extra, quote };
}

/** `bookIds`: Juan's ranked book. A directive on an account outside it
 *  (another rep's, or closed) is not offered here. */
export function buildReturnSuggestions(bookIds: Set<string>, directives: ReturnDirective[]): ReturnSuggestion[] {
  const week = planningHorizonDates(7);
  const weekSet = new Set(week);

  const seen = new Set<string>();
  type Parsed = ReturnType<typeof parseFollowUp>;
  const dated: { directive: ReturnDirective; parsed: Parsed; date: string }[] = [];
  const backlog: { directive: ReturnDirective; parsed: Parsed }[] = [];

  for (const d of directives) {
    if (seen.has(d.account_id) || !bookIds.has(d.account_id)) continue;
    const parsed = parseFollowUp(d.directive);
    const statedDate = parsed.statedTimeIso ? parsed.statedTimeIso.slice(0, 10) : null;
    if (statedDate && !weekSet.has(statedDate)) continue;
    seen.add(d.account_id);
    if (statedDate) dated.push({ directive: d, parsed, date: statedDate });
    else backlog.push({ directive: d, parsed });
  }

  const toSuggestion = (directive: ReturnDirective, parsed: Parsed, date: string): ReturnSuggestion => ({
    accountId: directive.account_id,
    reason: [parsed.title, parsed.extra].filter(Boolean).join(". "),
    quote: parsed.quote,
    statedTime: parsed.statedTimeIso,
    suggestedDate: date,
    directiveId: directive.id,
    loggedAt: directive.created_at,
  });

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
