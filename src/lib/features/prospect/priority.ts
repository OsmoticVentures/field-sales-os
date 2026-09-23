/**
 * Account priority. One deterministic function. Ported unchanged from the
 * NutriBiotic OS (portfolio/src/app/nutribiotic/lib/priority.ts): same
 * weights, same clauses, same bands. It is code, not a model: every number
 * below is arithmetic over columns that already exist, nothing here reads
 * free text or calls an LLM.
 *
 * SHARED-CORE NOTE (for whoever ports Route Planner or Visit Logger next):
 * this file also feeds the map pin card and Outbound's tie-break in the
 * source app. It is duplicated here rather than placed in src/lib/shared
 * only because this port's concurrency rules keep each agent inside its own
 * feature folder; move it to src/lib/shared/priority.ts, byte-identical,
 * the next time a second feature needs it, rather than forking a second
 * copy.
 *
 * No info is a score of 50, not a zero: an account none of whose inputs are
 * known scores a flat, neutral 50, never sorts as worst in the book. Three
 * real, measured facts still override the arithmetic outright: a hard
 * suppressor (closed / do-not-visit / Places-closed) caps the score at 10; a
 * client of 2+ years with under $300 lifetime is classified E for this score
 * only and capped below 50; and a Mother's Market location is floored at 78
 * regardless of its own order history, a named business call, not a
 * measurement.
 */

export const PRIORITY_WEIGHTS = { revenue: 45, engagement: 30, viability: 25 } as const;

/** A rep's own read of how close an account is to buying right now, set by
 *  hand. A flat point shift on the final score, never blended in as a
 *  fourth weighted component, so it always shows in the score as exactly
 *  what it is. */
export const READINESS_ADJUSTMENT = { urgent: 20, hot: 10, normal: 0, cold: -10 } as const;
export type Readiness = keyof typeof READINESS_ADJUSTMENT;

const RECENCY_FRESH_DAYS = 14;
const RECENCY_COLD_DAYS = 180;

/** HQ's A-G potential grade as an evenly spaced ordinal, a scale transform
 *  of a real stored grade, not a revenue estimate. */
const GRADE_SCALE: Record<string, number> = { A: 1, B: 0.83, C: 0.67, D: 0.5, E: 0.33, F: 0.17, G: 0 };

/** The score threshold an area's "how many 80+ prospects" count is built on. */
export const PROSPECT_SCORE_MIN = 80;

export type PriorityInput = {
  id: string;
  name: string;
  lifecycle: string | null;
  area?: string | null;
  channel?: string | null;
  origin?: string | null;
  fit_tags?: string[];
  tier: string | null;
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
  last_touch_at?: string | null;
  readiness?: Readiness | null;
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
  reason: string;
  confidence: number;
  inputsKnown: number;
  inputsTotal: number;
  parts: { revenue: number | null; engagement: number | null; viability: number | null };
  action: NextAction;
  suppressed: string | null;
};

const DAY = 86_400_000;

function daysBetween(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / DAY);
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Fraction of `values` strictly below `v`, a percentile over the real
 *  distribution of the book, not a band someone picked. */
function percentile(sorted: number[], v: number): number {
  if (sorted.length < 2) return 0.5;
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo / (sorted.length - 1);
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Score every account against the rest of the book. The revenue component
 * is a percentile inside Juan's own territory, so it needs the population:
 * there is no honest absolute dollar band, only "big compared to the rest
 * of this list".
 */
export function computePriority(rows: PriorityInput[], nowMs = Date.now()): Map<string, PriorityResult> {
  const t12 = rows.map((r) => r.trailing_12m_revenue).filter((v): v is number => typeof v === "number" && v > 0).sort((a, b) => a - b);
  const life = rows.map((r) => r.lifetime_revenue).filter((v): v is number => typeof v === "number" && v > 0).sort((a, b) => a - b);

  const out = new Map<string, PriorityResult>();

  for (const r of rows) {
    const clauses: string[] = [];

    const daysSinceOrder = daysBetween(r.last_order_at, nowMs);
    const boughtRecently = daysSinceOrder !== null && daysSinceOrder <= 365;
    let suppressed: string | null = null;
    if (r.closed_at) suppressed = "closed";
    else if (r.do_not_visit) suppressed = "do not visit";
    else if (r.places_status === "CLOSED_PERMANENTLY" && !boughtRecently) suppressed = "Places says closed permanently";

    const tenureDays = daysBetween(r.first_order_at, nowMs);
    const deadWeight =
      !suppressed &&
      typeof r.lifetime_revenue === "number" &&
      r.lifetime_revenue < 300 &&
      tenureDays !== null &&
      tenureDays > 730;
    const effectiveTier = deadWeight ? "E" : r.tier;

    // ---------------------------------------------------------------- revenue
    const revSubs: number[] = [];
    if (typeof r.trailing_12m_revenue === "number" && r.trailing_12m_revenue > 0) {
      revSubs.push(percentile(t12, r.trailing_12m_revenue));
      clauses.push(`${usd(r.trailing_12m_revenue)} in the last 12 months`);
    } else if (typeof r.lifetime_revenue === "number" && r.lifetime_revenue > 0) {
      revSubs.push(percentile(life, r.lifetime_revenue));
      clauses.push(`${usd(r.lifetime_revenue)} lifetime`);
    }
    if (effectiveTier && effectiveTier in GRADE_SCALE) {
      revSubs.push(GRADE_SCALE[effectiveTier]);
      clauses.push(
        deadWeight
          ? `under $300 in ${Math.floor((tenureDays as number) / 365)}y as a client, classified E`
          : `HQ potential ${effectiveTier}`,
      );
    }
    const revenue = revSubs.length ? revSubs.reduce((a, b) => a + b, 0) / revSubs.length : null;

    const isMothersMarket = /mother'?s market/i.test(r.name);

    // ------------------------------------------------------------- engagement
    const engSubs: number[] = [];
    if (typeof r.urgency === "number") {
      engSubs.push(r.urgency === 2 ? 1 : r.urgency === 1 ? 0.6 : 0.2);
      clauses.push(
        r.urgency === 2
          ? `draft needs a reply today${r.urgency_reason ? `: ${r.urgency_reason}` : ""}`
          : r.urgency === 1
            ? `open draft${r.urgency_reason ? `: ${r.urgency_reason}` : ""}`
            : "open draft, no urgency stated",
      );
    }
    const daysSinceTouch = daysBetween(r.last_touch_at, nowMs);
    if (daysSinceTouch !== null) {
      engSubs.push(
        daysSinceTouch <= RECENCY_FRESH_DAYS
          ? 1
          : clamp01((RECENCY_COLD_DAYS - daysSinceTouch) / (RECENCY_COLD_DAYS - RECENCY_FRESH_DAYS)),
      );
      clauses.push(daysSinceTouch === 0 ? "touched today" : `last touch ${daysSinceTouch}d ago`);
    }
    const engagement = engSubs.length ? engSubs.reduce((a, b) => a + b, 0) / engSubs.length : null;

    // -------------------------------------------------------------- viability
    const viaSubs: number[] = [];
    if (r.expected_reorder_days && daysSinceOrder !== null) {
      const ratio = daysSinceOrder / r.expected_reorder_days;
      const overdueDays = daysSinceOrder - r.expected_reorder_days;
      viaSubs.push(ratio < 0.5 ? 0.4 : ratio <= 1.5 ? 1 : ratio <= 2.5 ? 0.7 : 0.3);
      clauses.push(
        overdueDays > 0
          ? `reorder ${overdueDays}d overdue on its own ${r.expected_reorder_days}d cycle`
          : `reorder due in ${-overdueDays}d on its own ${r.expected_reorder_days}d cycle`,
      );
    } else if (daysSinceOrder !== null) {
      clauses.push(`last order ${daysSinceOrder}d ago`);
    }
    if (r.lifecycle) {
      const byLifecycle: Record<string, number> = { active: 1, prospect: 0.6, dormant: 0.5, lost: 0.1 };
      if (r.lifecycle in byLifecycle) {
        viaSubs.push(byLifecycle[r.lifecycle]);
        clauses.push(r.lifecycle);
      }
    }
    const viability = suppressed ? 0 : viaSubs.length ? viaSubs.reduce((a, b) => a + b, 0) / viaSubs.length : null;

    // --------------------------------------------------------- known-only sum
    const pairs: [number | null, number][] = [
      [revenue, PRIORITY_WEIGHTS.revenue],
      [engagement, PRIORITY_WEIGHTS.engagement],
      [viability, PRIORITY_WEIGHTS.viability],
    ];
    const known = pairs.filter(([v]) => v !== null) as [number, number][];
    const totalW = PRIORITY_WEIGHTS.revenue + PRIORITY_WEIGHTS.engagement + PRIORITY_WEIGHTS.viability;
    const knownW = known.reduce((a, [, w]) => a + w, 0);
    const noInfo = knownW === 0;
    let score: number | null = noInfo ? 50 : Math.round((known.reduce((a, [v, w]) => a + v * w, 0) / knownW) * 100);

    // -------------------------------------------------------------- readiness
    if (r.readiness && score !== null) {
      score = Math.max(0, Math.min(100, score + READINESS_ADJUSTMENT[r.readiness]));
      clauses.push(`Lead readiness: ${r.readiness}`);
    }
    if (suppressed && score !== null) score = Math.min(score, 10);
    if (deadWeight && score !== null) score = Math.min(score, 49);
    if (isMothersMarket && !suppressed && score !== null) {
      score = Math.max(score, 78);
      clauses.push("Mother's Market, flagged high priority");
    }

    const inputsKnown = known.length;
    const confidence =
      (PRIORITY_WEIGHTS.revenue * (revSubs.length / 2) +
        PRIORITY_WEIGHTS.engagement * (engSubs.length / 2) +
        PRIORITY_WEIGHTS.viability * (viaSubs.length / 2)) /
      totalW;

    let reason: string;
    if (suppressed) {
      reason = `${suppressed}${clauses.length ? `, ${clauses.join(", ")}` : ""}`;
    } else if (noInfo) {
      reason =
        "no revenue, engagement or lifecycle data on file yet, scored neutral at 50" +
        (r.readiness ? `, Lead readiness: ${r.readiness}` : "");
    } else {
      reason = clauses.join(", ");
    }
    if (!noInfo && confidence < 0.6) {
      reason += `, scored on ${revSubs.length + engSubs.length + viaSubs.length} of 6 inputs`;
    }

    const band: PriorityResult["band"] =
      score === null ? "unscored" : suppressed ? "later" : score >= 78 ? "now" : score >= 55 ? "soon" : "later";

    out.set(r.id, {
      id: r.id,
      score,
      band,
      reason,
      confidence,
      inputsKnown,
      inputsTotal: 3,
      parts: { revenue, engagement, viability },
      action: nextAction(r, { daysSinceOrder, suppressed }),
      suppressed,
    });
  }

  return out;
}

/**
 * The one prescriptive step. Every action deep-links into the Prospect
 * screen (email/Outbound and open map focus are not ported here yet); a
 * later port can widen these hrefs once those screens exist in this app.
 */
function nextAction(r: PriorityInput, ctx: { daysSinceOrder: number | null; suppressed: string | null }): NextAction {
  if (ctx.suppressed) {
    return { kind: "open", label: "Review", href: `/prospect?account=${r.id}` };
  }
  if (typeof r.urgency === "number" && r.urgency >= 1) {
    return { kind: "email", label: "Answer the open draft", href: `/prospect?account=${r.id}` };
  }
  if (r.expected_reorder_days && ctx.daysSinceOrder !== null && ctx.daysSinceOrder > r.expected_reorder_days && r.phone) {
    return { kind: "call", label: "Call about the reorder", href: `/prospect?account=${r.id}` };
  }
  if (r.phone && (r.lifecycle === "dormant" || r.lifecycle === "lost")) {
    return { kind: "call", label: "Call to reopen", href: `/prospect?account=${r.id}` };
  }
  return { kind: "visit", label: "Put on a route", href: `/prospect?account=${r.id}` };
}

/** The comparator every surface sorts with. Null sorts last, never as zero. */
export function byPriority(a: PriorityResult | undefined, b: PriorityResult | undefined): number {
  const av = a?.score ?? -1;
  const bv = b?.score ?? -1;
  if (av !== bv) return bv - av;
  return (b?.confidence ?? 0) - (a?.confidence ?? 0);
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
