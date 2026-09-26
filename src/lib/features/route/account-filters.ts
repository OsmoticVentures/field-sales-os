/**
 * The map's filter vocabulary, ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/account-filters.ts). Framework-free:
 * the taxonomy, the counting and the predicate, nothing about rendering.
 *
 * FOUR SECTIONS on this screen (areas, tier, readiness, type, lead status.
 * chains/practices/prospects are hide toggles, not filter chips, same
 * distinction the source draws). Nothing here invents a classification:
 * every chip reads a column that already exists on RouteAccount.
 */

import type { Readiness } from "../prospect/priority";
import type { LeadStage, Tier } from "./types";

// --- Readiness -----------------------------------------------------------

export const READINESS_FILTERS = ["urgent", "hot", "normal", "cold"] as const;
export type ReadinessFilter = (typeof READINESS_FILTERS)[number];

export const READINESS_LABEL: Record<ReadinessFilter, string> = {
  urgent: "Urgent",
  hot: "Hot",
  normal: "Normal",
  cold: "Cold",
};

export const READINESS_COLOR: Record<ReadinessFilter, string> = {
  urgent: "#B5372A",
  hot: "#D97E2B",
  normal: "#8A928C",
  cold: "#4E7FA8",
};

/** Juan's own number: the standalone 75+ score chip, separate from
 *  priority.ts's "now" band (78) and PROSPECT_SCORE_MIN (80). */
export const HOT_SCORE_MIN = 75;

// --- Type ------------------------------------------------------------------

export const ACCOUNT_TYPES = ["retail", "clinics", "beauty", "sports", "animal", "other"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  retail: "Retail",
  clinics: "Clinics",
  beauty: "Beauty",
  sports: "Sports",
  animal: "Animal",
  other: "Other",
};

const CHANNEL_TYPE: Record<string, AccountType> = {
  grocery: "retail",
  specialty: "retail",
  mass_retail: "retail",
  holistic_retail: "retail",
  pharmacy: "retail",
  online_retailer: "retail",
  coop: "retail",
  clinic: "clinics",
  holistic_health_services: "clinics",
  spa_beauty: "beauty",
  gym: "sports",
  nutrition_club: "sports",
  pet_specialty: "animal",
  animal_rescue_nonprofit: "animal",
};

export function accountType(channel: string | null | undefined): AccountType {
  if (!channel) return "other";
  return CHANNEL_TYPE[channel] ?? "other";
}

/** The Practices hide toggle's predicate: channel is a clinic/practice and
 *  HQ potential grades E. A clinic that grades higher counts under Type's
 *  Clinics chip instead. */
export function isSmallPractice(channel: string | null | undefined, tier: Tier | null | undefined): boolean {
  return accountType(channel) === "clinics" && tier === "E";
}

// --- Lead status -----------------------------------------------------------

export const LEAD_STAGES: LeadStage[] = ["prospect", "new_to_activate", "active", "dormant", "closed"];

export const LEAD_STAGE_LABEL: Record<LeadStage, string> = {
  prospect: "Prospect",
  new_to_activate: "New to Activate",
  active: "Active",
  dormant: "Dormant",
  closed: "Closed",
};

export const LEAD_STAGE_COLOR: Record<LeadStage, string> = {
  prospect: "#4E7FA8",
  new_to_activate: "#C79A1E",
  active: "#3F7D4F",
  dormant: "#D97E2B",
  closed: "#8A928C",
};

// --- The state, the subject, the predicate ----------------------------------

export type FilterSubject = {
  id: string;
  area: string | null;
  tier: Tier | null;
  readiness: Readiness | null;
  score: number | null;
  channel: string | null;
  leadStage: LeadStage | null;
};

/** Empty set means UNFILTERED, never "nothing matches": a chip narrows on
 *  the first click and widens again on the second. */
export type AccountFilterState = {
  areas: Set<string>;
  tiers: Set<Tier>;
  readiness: Set<ReadinessFilter>;
  hotScore: boolean;
  types: Set<AccountType>;
  stages: Set<LeadStage>;
};

export function emptyFilters(): AccountFilterState {
  return { areas: new Set(), tiers: new Set(), readiness: new Set(), hotScore: false, types: new Set(), stages: new Set() };
}

export function activeFilterCount(f: AccountFilterState): number {
  return f.areas.size + f.tiers.size + f.readiness.size + (f.hotScore ? 1 : 0) + f.types.size + f.stages.size;
}

/** Every section narrows independently and combines with AND; within a
 *  section it is OR. Readiness tags and the 75+ score chip are one
 *  question together, so they OR with each other too. */
export function matchesFilters(f: AccountFilterState, s: FilterSubject): boolean {
  if (f.areas.size > 0 && !(s.area !== null && f.areas.has(s.area))) return false;
  if (f.tiers.size > 0 && !(s.tier !== null && f.tiers.has(s.tier))) return false;

  const readinessAsked = f.readiness.size > 0 || f.hotScore;
  if (readinessAsked) {
    const byTag = s.readiness !== null && f.readiness.has(s.readiness as ReadinessFilter);
    const byScore = f.hotScore && typeof s.score === "number" && s.score >= HOT_SCORE_MIN;
    if (!byTag && !byScore) return false;
  }

  if (f.types.size > 0 && !f.types.has(accountType(s.channel))) return false;
  if (f.stages.size > 0 && !(s.leadStage !== null && f.stages.has(s.leadStage))) return false;
  return true;
}

export type FilterCounts = {
  areas: Record<string, number>;
  tiers: Record<string, number>;
  readiness: Record<string, number>;
  hotScore: number;
  types: Record<string, number>;
  stages: Record<string, number>;
};

/** Counted over the whole (display-narrowed) subject list, not over the
 *  current selection: each chip's own count has to stay whole for every
 *  other chip to still make sense picked alongside it. */
export function countSubjects(subjects: FilterSubject[]): FilterCounts {
  const counts: FilterCounts = { areas: {}, tiers: {}, readiness: {}, hotScore: 0, types: {}, stages: {} };
  for (const s of subjects) {
    if (s.area) counts.areas[s.area] = (counts.areas[s.area] ?? 0) + 1;
    if (s.tier) counts.tiers[s.tier] = (counts.tiers[s.tier] ?? 0) + 1;
    if (s.readiness) counts.readiness[s.readiness] = (counts.readiness[s.readiness] ?? 0) + 1;
    if (typeof s.score === "number" && s.score >= HOT_SCORE_MIN) counts.hotScore += 1;
    const t = accountType(s.channel);
    counts.types[t] = (counts.types[t] ?? 0) + 1;
    if (s.leadStage) counts.stages[s.leadStage] = (counts.stages[s.leadStage] ?? 0) + 1;
  }
  return counts;
}
