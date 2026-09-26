/**
 * Plan week orchestration: gathers Juan's owned book, the priority engine's
 * due read, and pending return-visit directives, then runs plan.ts's pure
 * core twice.
 *
 * PASS 1, TRIAL. Decides which stop lands on which day and in what order,
 * scored by straight-line miles (fast enough to try every candidate against
 * every day, which the insertion search in plan.ts does a lot of).
 *
 * PASS 2, REFINE. Once the order is settled, one real OSRM call per day
 * (drive.ts) replaces the straight-line numbers with real road legs, same
 * as plan_week.py's own precedent: "a refine pass replaces these numbers
 * and nothing else about the day changes." When OSRM has nothing for a leg
 * (offline, or a stop that failed to return a route), that leg keeps its
 * straight-line estimate, still labelled `driveEstimated: true`, never
 * silently presented as a real number.
 *
 * WHO IS DUE, IN THIS PORT. Priority (getPriorityBook, unchanged, the same
 * revenue/engagement/viability scoring the Prospect screen uses) stands in
 * for cadence-due here: closed and chain-excluded accounts are already out
 * of that book's SQL (prospect/dal.ts), and a do-not-visit account is
 * suppressed to a score under the "soon" floor this file also uses as the
 * due threshold, so it never qualifies as a due candidate. Follow-ups due
 * means the same nb_directives return-visit directives Suggested returns
 * already reads (return-suggestions.ts); a HubSpot Task-based follow-up
 * (tasks_due.py in the bridge) has no equivalent ported into this app yet,
 * noted here rather than silently narrowed.
 */
import "server-only";
import {
  JUAN_OWNER_ID,
  getAccountsByIds,
  getHomeEndpoint,
  getRouteEndpointsByDay,
  getRouteSchedulePrefs,
  getRouteStateByDay,
  isConfigured,
  listOwnerAccounts,
  listPendingReturnDirectives,
} from "../route/dal";
import { getPriorityBook } from "../prospect/dal";
import { buildReturnSuggestions } from "../route/return-suggestions";
import { planningHorizonDates } from "../route/field-week";
import { haversineMiles } from "../route/route-optimize";
import { routeDriveShape } from "../route/drive";
import { buildWeekPlan, scheduleDay } from "./plan";
import type { PlanWorkingStop } from "./plan";
import {
  DEFAULT_PLANNER_OPTIONS,
  type LegEstimate,
  type LegMinutesFn,
  type PlanAccount,
  type PlanAnchor,
  type PlanEndpoint,
  type PlannedDay,
  type PlannerOptions,
  type ProposedWeek,
  type UnroutableEntry,
} from "./types";

/** The floor of priority.ts's "soon" band: below this, an account isn't
 *  worth a special trip this week, on top of anything Suggested returns
 *  already surfaces for it. */
const DUE_SCORE_MIN = 55;
const DEFAULT_HORIZON_DAYS = 7;
export const MIN_HORIZON_DAYS = 1;
export const MAX_HORIZON_DAYS = 10;

/** SoCal blended city/freeway average, used only to rank trial insertions
 *  cheaply and as the last-resort fallback when OSRM has nothing for a
 *  specific leg. Never the number shown for a leg OSRM did answer. */
const TRIAL_MPH = 24;

function trialLegMinutes(a: { lat: number; lng: number }, b: { lat: number; lng: number }): LegEstimate {
  const miles = haversineMiles(a, b);
  return { minutes: (miles / TRIAL_MPH) * 60, miles, estimated: true };
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** A close time at or before its own open time is corrupt data, not a
 *  closed-all-day account (nutribiotic-route-planner's plan_week.py rule
 *  4): reported and excluded, never guessed at. */
function hasCorruptHours(bh: Record<string, string[][]> | null): boolean {
  if (!bh) return false;
  for (const ranges of Object.values(bh)) {
    for (const [start, end] of ranges) {
      if (toMinutes(end) <= toMinutes(start)) return true;
    }
  }
  return false;
}

export type ProposeResult =
  | { status: "ok"; week: ProposedWeek }
  | { status: "blocked"; reason: string };

export async function proposeWeek(daysCount: number = DEFAULT_HORIZON_DAYS): Promise<ProposeResult> {
  if (!isConfigured()) return { status: "blocked", reason: "No data source configured." };

  const count = Math.min(MAX_HORIZON_DAYS, Math.max(MIN_HORIZON_DAYS, Math.round(daysCount) || DEFAULT_HORIZON_DAYS));

  const [home, endpoints, prefs, state, book, directives, accounts] = await Promise.all([
    getHomeEndpoint(),
    getRouteEndpointsByDay(),
    getRouteSchedulePrefs(),
    getRouteStateByDay(),
    getPriorityBook(),
    listPendingReturnDirectives(),
    listOwnerAccounts(),
  ]);

  if (!home) return { status: "blocked", reason: "No home base on file to start or end a day from." };

  const options: PlannerOptions = {
    ...DEFAULT_PLANNER_OPTIONS,
    departTime: prefs.depart,
    dwellMinutes: prefs.dwellMinutes,
    lunchMinutes: prefs.lunchMinutes,
  };

  const horizon = planningHorizonDates(count);
  const days = horizon.map((date) => ({
    date,
    start: (endpoints.start[date] ?? home) as PlanEndpoint,
    end: (endpoints.end[date] ?? home) as PlanEndpoint,
  }));

  // Accounts already hand-placed anywhere in the horizon: skipped so a
  // due/return account Juan already put on a day himself is never doubled.
  const usedAccountIds = new Set<string>();
  for (const date of horizon) {
    for (const entry of state.draft[date] ?? []) {
      if (typeof entry === "string") usedAccountIds.add(entry);
    }
  }

  const geocodedById = new Map(accounts.map((a) => [a.id, a]));
  const unroutable: UnroutableEntry[] = [];
  const candidates: PlanAccount[] = [];

  for (const { account, result } of book.ranked) {
    if (result.score === null || result.score < DUE_SCORE_MIN) continue;
    if (usedAccountIds.has(account.id)) continue;
    const geo = geocodedById.get(account.id);
    if (!geo) {
      unroutable.push({ accountId: account.id, name: account.name, reason: "no coordinates" });
      continue;
    }
    if (hasCorruptHours(geo.business_hours)) {
      unroutable.push({ accountId: account.id, name: account.name, reason: "corrupt hours" });
      continue;
    }
    candidates.push({
      id: account.id,
      name: account.name,
      lat: geo.lat,
      lng: geo.lng,
      businessHours: geo.business_hours,
      reason: result.reason,
      score: result.score,
    });
  }

  // routableIds: the priority book's own read of "not closed, not
  // do-not-visit" (closed_at and chain_excluded are already out of the
  // book's SQL; suppressed !== null is do-not-visit or Places-closed).
  const routableIds = new Set(book.ranked.filter((r) => r.result.suppressed === null).map((r) => r.account.id));

  const directiveAccountIds = [...new Set(directives.map((d) => d.account_id))];
  const rawFacts = await getAccountsByIds(directiveAccountIds);
  const factsById = new Map(rawFacts.map((f) => [f.id, f]));

  for (const id of directiveAccountIds) {
    if (routableIds.has(id) && geocodedById.has(id)) continue; // handled by return-suggestions below
    const f = factsById.get(id);
    if (!f) {
      unroutable.push({ accountId: id, name: id, reason: "no coordinates" });
      continue;
    }
    if (f.hubspot_owner_id !== JUAN_OWNER_ID) continue; // not his account, not his to route
    if (f.closed_at) unroutable.push({ accountId: id, name: f.name, reason: "closed" });
    else if (f.chain_excluded) unroutable.push({ accountId: id, name: f.name, reason: "corporate-gated" });
    else if (f.do_not_visit) unroutable.push({ accountId: id, name: f.name, reason: "do not visit" });
    else if (f.lat === null || f.lng === null) unroutable.push({ accountId: id, name: f.name, reason: "no coordinates" });
  }

  const suggestions = buildReturnSuggestions(routableIds, directives);

  const accountsById = new Map<string, PlanAccount>(candidates.map((c) => [c.id, c]));
  for (const s of suggestions) {
    if (accountsById.has(s.accountId) || usedAccountIds.has(s.accountId)) continue;
    const geo = geocodedById.get(s.accountId);
    if (!geo) continue; // already reported unroutable above
    accountsById.set(s.accountId, {
      id: s.accountId,
      name: geo.name,
      lat: geo.lat,
      lng: geo.lng,
      businessHours: geo.business_hours,
      reason: "",
      score: null,
    });
  }

  const anchors: PlanAnchor[] = suggestions
    .filter((s) => accountsById.has(s.accountId) && !usedAccountIds.has(s.accountId))
    .map((s) => ({
      accountId: s.accountId,
      date: s.suggestedDate,
      statedTimeIso: s.statedTime,
      reason: s.reason,
      quote: s.quote,
      directiveId: s.directiveId,
    }));

  const trial = buildWeekPlan({
    days,
    accountsById,
    candidates,
    anchors,
    usedAccountIds,
    legMinutes: trialLegMinutes,
    options,
  });

  const refinedDays = await Promise.all(trial.days.map((day) => refineDay(day, days.find((d) => d.date === day.date)!, accountsById, options)));

  return { status: "ok", week: { days: refinedDays, unroutable } };
}

/** Pass 2: re-walks one day's already-decided stop order with real OSRM
 *  legs (drive.ts). The order itself never changes here, only the numbers
 *  and anything the numbers feed (arrival time, hours push, lunch slot). */
async function refineDay(
  day: PlannedDay,
  endpoints: { date: string; start: PlanEndpoint; end: PlanEndpoint },
  accountsById: Map<string, PlanAccount>,
  options: PlannerOptions,
): Promise<PlannedDay> {
  if (day.stops.length === 0) return day;

  const order: PlanWorkingStop[] = day.stops.map((s) => ({
    accountId: s.accountId,
    name: s.name,
    lat: s.lat,
    lng: s.lng,
    kind: s.kind,
    businessHours: accountsById.get(s.accountId)?.businessHours ?? null,
    reason: s.why,
    quote: s.quote,
    statedTimeIso: s.statedTime,
    directiveId: s.directiveId,
  }));

  const points = [endpoints.start, ...order.map((s) => ({ lat: s.lat, lng: s.lng }))];
  const shape = await routeDriveShape(points);
  const legs = shape?.legs ?? null;

  let idx = 0;
  const legMinutes: LegMinutesFn = (a, b) => {
    const leg = legs?.[idx];
    idx += 1;
    if (leg) return { minutes: leg.minutes, miles: leg.miles, estimated: false };
    return trialLegMinutes(a, b);
  };

  return scheduleDay({ date: endpoints.date, start: endpoints.start, end: endpoints.end, order }, options, legMinutes);
}
