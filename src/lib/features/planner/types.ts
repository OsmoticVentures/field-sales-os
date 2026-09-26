/**
 * Shared shapes for Plan week. Framework-free, no I/O, so plan.ts (the pure
 * planner) and propose.ts (the server orchestration) agree on one contract
 * and a standalone test can build these by hand with synthetic accounts.
 */

export type PlanPoint = { lat: number; lng: number };

export type PlanEndpoint = PlanPoint & { label: string; address: string };

/** One geocoded, owned, open-to-visit account, already scored. `reason` is
 *  the priority engine's own clause list, verbatim, never rewritten here. */
export type PlanAccount = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  businessHours: Record<string, string[][]> | null;
  reason: string;
  score: number | null;
};

/** A pending return-visit directive, already resolved to one date by
 *  return-suggestions.ts's own dated/backlog split. `statedTimeIso` is set
 *  only when Juan or the client stated a real time; otherwise this is a
 *  same-day candidate placed by cheapest insertion, not a fixed anchor. */
export type PlanAnchor = {
  accountId: string;
  date: string; // YYYY-MM-DD
  statedTimeIso: string | null; // RFC3339, local wall-clock read from it
  reason: string; // the directive's own wording, verbatim
  quote: string | null;
  directiveId: string;
};

export type PlannerOptions = {
  departTime: string; // "09:30", local wall clock
  dwellMinutes: number;
  lunchMinutes: number;
  /** ~10 stops a day at most (nutribiotic-route-planner rule 6). */
  maxStopsPerDay: number;
  /** No leg over ~3 hours (rule 0.6). */
  maxDriveLegMinutes: number;
  /** A day's own clock: depart to last stop's departure, before the drive
   *  home is even added. Keeps a day from growing past a real workday even
   *  when it's still under the stop cap. */
  maxDayMinutes: number;
};

export const DEFAULT_PLANNER_OPTIONS: PlannerOptions = {
  departTime: "09:30",
  dwellMinutes: 20,
  lunchMinutes: 30,
  maxStopsPerDay: 10,
  maxDriveLegMinutes: 180,
  maxDayMinutes: 540,
};

/** A leg's minutes, and whether that number came from the real road network
 *  (OSRM) or a straight-line fallback. Never invented when neither source
 *  could compute it; the caller returns null in that case. */
export type LegEstimate = { minutes: number; miles: number; estimated: boolean } | null;
export type LegMinutesFn = (a: PlanPoint, b: PlanPoint) => LegEstimate;

export type PlannedStopKind = "anchor" | "due" | "return";

export type PlannedStop = {
  accountId: string;
  name: string;
  lat: number;
  lng: number;
  kind: PlannedStopKind;
  arrive: string; // "HH:MM" local
  depart: string; // "HH:MM" local
  driveFromPrevMinutes: number | null;
  driveFromPrevMiles: number | null;
  driveEstimated: boolean;
  why: string; // verbatim source clause, never invented
  quote: string | null;
  statedTime: string | null; // RFC3339, only for a timed anchor
  hoursNote: string | null; // "hours unknown" | "opens at 5PM" | null
  mapsUrl: string;
  directiveId: string | null;
};

export type PlannedDay = {
  date: string;
  stops: PlannedStop[];
  overnight: boolean;
  driveMinutesTotal: number;
  driveEstimateAvailable: boolean;
  warnings: string[];
};

export type UnroutableReason = "no coordinates" | "closed" | "do not visit" | "corporate-gated" | "corrupt hours";

export type UnroutableEntry = { accountId: string; name: string; reason: UnroutableReason };

export type ProposedWeek = {
  days: PlannedDay[];
  unroutable: UnroutableEntry[];
};
