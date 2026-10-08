import {
  EMPTY_SIGNALS,
  dayDiff,
  laDay,
  potentialNow,
  sdrClauses,
  sdrScore,
  LINE,
  type GradeFrom,
  type Readiness,
  type ScoreInput,
  type Signals,
} from "./sdr-score";

export type { Readiness } from "./sdr-score";
export { buildSignals, laDay, CORP_PREFILTER, NOTE_PREFILTER, TOUCH_KINDS } from "./sdr-score";
export type { RawNote, RawOrder, RawOrderEmail, RawTouch, Signals } from "./sdr-score";

/**
 * Account priority for ClientOS: the potential grade and potential score from
 * sdr-score.ts (the rules and their reasons live there, shared byte for byte
 * with the portfolio NutriBiotic OS and matched to the action lists sheet),
 * plus the hard suppressors, the band, and the one next action. Pure, nothing
 * stored.
 */

/** The score threshold an area's "how many 80+ prospects" count is built on. */
export const PROSPECT_SCORE_MIN = 80;

export type PriorityInput = ScoreInput & {
  id: string;
  name: string;
  lifecycle: string | null;
  area?: string | null;
  channel?: string | null;
  origin?: string | null;
  fit_tags?: string[];
  trailing_12m_revenue: number | null;
  lifetime_revenue: number | null;
  first_order_at: string | null;
  last_order_at: string | null;
  expected_reorder_days: number | null;
  places_status?: string | null;
  closed_at?: string | null;
  do_not_visit?: boolean | null;
  phone?: string | null;
  urgency?: number | null;
  urgency_reason?: string | null;
};

export type NextAction = {
  kind: "call" | "visit" | "email" | "open";
  label: string;
  href: string;
};

export type PriorityResult = {
  id: string;
  score: number | null;
  band: "now" | "soon" | "later" | "unscored";
  /** The potential letter, A to G, or null when nothing is known. */
  grade: string | null;
  gradeFrom: GradeFrom;
  reason: string;
  /** A note says buying is decided at corporate. */
  corporate: boolean;
  action: NextAction;
  suppressed: string | null;
};

export function computePriority(
  rows: PriorityInput[],
  signals: Map<string, Signals>,
  nowMs = Date.now(),
): Map<string, PriorityResult> {
  const today = laDay(new Date(nowMs));
  const out = new Map<string, PriorityResult>();

  for (const r of rows) {
    const s: Signals = signals.get(r.id) ?? EMPTY_SIGNALS;
    const lastOrderDays = r.last_order_at ? dayDiff(today, r.last_order_at.slice(0, 10)) : null;
    const boughtRecently = lastOrderDays !== null && lastOrderDays <= 365;
    let suppressed: string | null = null;
    if (r.closed_at) suppressed = "closed";
    else if (r.do_not_visit) suppressed = "do not visit";
    else if (r.places_status === "CLOSED_PERMANENTLY" && !boughtRecently) suppressed = "Places says closed permanently";

    const { grade, from } = potentialNow(r, s.peak);
    let score = sdrScore(r, s, grade, today, from);
    if (suppressed) score = Math.min(score, 10);

    const clauses = [...(suppressed ? [suppressed] : []), ...sdrClauses(r, s, grade, from, today)];

    const band: PriorityResult["band"] = suppressed ? "later" : score >= 75 ? "now" : score >= LINE ? "soon" : "later";
    out.set(r.id, {
      id: r.id,
      score,
      band,
      grade,
      gradeFrom: from,
      reason: clauses.join(", "),
      corporate: s.corp,
      action: nextAction(r, { lastOrderDays, suppressed, score }),
      suppressed,
    });
  }
  return out;
}

/** The one prescriptive step. Every action deep-links into the Prospect screen. */
function nextAction(r: PriorityInput, ctx: { lastOrderDays: number | null; suppressed: string | null; score: number }): NextAction {
  if (ctx.suppressed) {
    return { kind: "open", label: "Review", href: `/prospect?account=${r.id}` };
  }
  if (typeof r.urgency === "number" && r.urgency >= 1) {
    return { kind: "email", label: "Answer the open draft", href: `/prospect?account=${r.id}` };
  }
  if (r.expected_reorder_days && ctx.lastOrderDays !== null && ctx.lastOrderDays > r.expected_reorder_days && r.phone) {
    return { kind: "call", label: "Call about the reorder", href: `/prospect?account=${r.id}` };
  }
  if (r.phone && (r.lifecycle === "dormant" || r.lifecycle === "lost")) {
    return { kind: "call", label: "Call to reopen", href: `/prospect?account=${r.id}` };
  }
  // Under the line (50) is email and phone only; 50 and up goes on a route.
  if (ctx.score < LINE) {
    return r.phone
      ? { kind: "call", label: "Call or email", href: `/prospect?account=${r.id}` }
      : { kind: "email", label: "Email", href: `/prospect?account=${r.id}` };
  }
  return { kind: "visit", label: "Put on a route", href: `/prospect?account=${r.id}` };
}

/** The comparator every surface sorts with. Null sorts last, never as zero. */
export function byPriority(a: PriorityResult | undefined, b: PriorityResult | undefined): number {
  return (b?.score ?? -1) - (a?.score ?? -1);
}

/** A hand-typed account always outranks one landed off a Search sweep,
 *  score or no score. */
export function byOriginThenPriority(
  a: { account: PriorityInput; result: PriorityResult },
  b: { account: PriorityInput; result: PriorityResult },
): number {
  const rank = (origin: string | null | undefined) => (origin === "manual" ? 0 : origin === "enriched" ? 2 : 1);
  const ar = rank(a.account.origin);
  const br = rank(b.account.origin);
  if (ar !== br) return ar - br;
  return byPriority(a.result, b.result);
}

/** How many accounts in each area currently score PROSPECT_SCORE_MIN or
 *  better, keyed by area id. An account with no area counts nowhere. */
export function areaProspectCounts(
  rows: { id: string; area?: string | null }[],
  byId: Map<string, PriorityResult>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.area) continue;
    const score = byId.get(r.id)?.score;
    if (typeof score !== "number" || score < PROSPECT_SCORE_MIN) continue;
    counts.set(r.area, (counts.get(r.area) ?? 0) + 1);
  }
  return counts;
}

/** Sort any list of areas by prospect count desc, then id. */
export function sortAreasByProspects<T extends { id: string }>(areas: T[], counts: Map<string, number>): T[] {
  return [...areas].sort((a, b) => {
    const d = (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
}

export function bandLabel(band: PriorityResult["band"]): string {
  return band === "now" ? "high impact" : band === "soon" ? "worth a stop" : band === "later" ? "low" : "not scored";
}
