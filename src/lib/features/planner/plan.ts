/**
 * Plan week's pure core: turns due accounts and return-visit anchors into a
 * drivable day, and nothing else. No fetch, no Supabase, no OSRM call in
 * here, so it runs the same in a standalone test as it does in the route
 * handler. The orchestration that gathers accounts/directives and supplies
 * real drive minutes lives in propose.ts.
 *
 * RULES THIS FILE ENFORCES, EACH WITH ITS OWN COMMENT BELOW:
 *   - A stated time is an anchor; the day bends around it (rule 0.5).
 *   - No drive leg over ~3 hours (rule 0.6), checked after every insertion.
 *   - Geography before priority: a due account is inserted wherever it costs
 *     the least to add, evaluated across every day at once, priority order
 *     only decides which account gets first pick of a gap.
 *   - No hours on file: scheduled, flagged "hours unknown", nudged toward
 *     midday rather than the first or last slot of the day.
 *   - About 10 stops a day, fewer if the day's own clock cannot fit them.
 *   - Never invents a drive time: legMinutes returns null when it has no
 *     basis to compute one, and that leg is carried as null, not guessed.
 */
import { pushToOpenWindow } from "../route/hours";
import { haversineMiles } from "../route/route-optimize";
import type {
  LegMinutesFn,
  PlanAccount,
  PlanAnchor,
  PlanEndpoint,
  PlannedDay,
  PlannedStop,
  PlannerOptions,
  ProposedWeek,
} from "./types";

// --- small, local, no-dependency helpers -----------------------------------

export function hhmmToMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return 0;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToHHMM(mins: number): string {
  const clamped = Math.max(0, Math.round(mins));
  const h = Math.floor(clamped / 60) % 24;
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** A directive's "Stated time: <RFC3339>" read as LA wall-clock minutes,
 *  since that's the clock the rest of the day is built on. */
export function laClockMinutesFromIso(iso: string): number {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

export function appleMapsUrl(p: { lat: number; lng: number }): string {
  return `https://maps.apple.com/?daddr=${p.lat},${p.lng}`;
}

// --- working shape while a day is being assembled --------------------------

type WorkingStop = {
  accountId: string;
  name: string;
  lat: number;
  lng: number;
  kind: PlannedStop["kind"];
  businessHours: Record<string, string[][]> | null;
  reason: string;
  quote: string | null;
  statedTimeIso: string | null;
  directiveId: string | null;
};

/** Public alias: propose.ts's refine pass reconstructs this shape from its
 *  own account/anchor maps to re-walk a day's already-decided order with
 *  real (OSRM) drive minutes, without repeating the insertion/optimization
 *  this file already did once. */
export type PlanWorkingStop = WorkingStop;

type DayBuild = {
  date: string;
  start: PlanEndpoint;
  end: PlanEndpoint;
  order: WorkingStop[];
  warnings: string[];
};

/** Cost, in straight-line miles, of inserting `p` between the two points
 *  either side of gap index `i` in `order` (start/end when at either edge).
 *  Pure geography, the same metric route-optimize.ts's cheapestGap uses,
 *  kept local here since insertion also needs an hours-aware tie-break
 *  cheapestGap doesn't have. */
function gapCosts(day: DayBuild, p: { lat: number; lng: number }): { gap: number; costMiles: number }[] {
  const left = (i: number) => (i === 0 ? day.start : day.order[i - 1]);
  const right = (i: number) => (i === day.order.length ? day.end : day.order[i]);
  const costs: { gap: number; costMiles: number }[] = [];
  for (let gap = 0; gap <= day.order.length; gap++) {
    const l = left(gap);
    const r = right(gap);
    const toLeft = haversineMiles(l, p);
    const toRight = haversineMiles(p, r);
    const bridged = haversineMiles(l, r);
    costs.push({ gap, costMiles: toLeft + toRight - bridged });
  }
  return costs;
}

/** Where a stop should go: cheapest gap, except when its hours are unknown,
 *  where a gap within 25% of the cheapest is preferred if it lands closer to
 *  midday (rule 3: "no hours on file is scheduled mid-day"). Arrival time
 *  used for the midday read is a straight-line placeholder just for ranking
 *  gaps; the real schedule is recomputed from legMinutes afterward. */
function chooseGap(day: DayBuild, stop: WorkingStop, options: PlannerOptions): number {
  const costs = gapCosts(day, stop);
  const hoursUnknown = !stop.businessHours || Object.keys(stop.businessHours).length === 0;
  const cheapest = costs.reduce((a, b) => (b.costMiles < a.costMiles ? b : a));
  if (!hoursUnknown) return cheapest.gap;

  const threshold = cheapest.costMiles * 1.25 + 1; // +1mi so a near-zero cheapest gap still has candidates
  const near = costs.filter((c) => c.costMiles <= threshold);
  let bestGap = cheapest.gap;
  let bestDeltaFromMidday = Infinity;
  for (const c of near) {
    const placeholderMinutes = hhmmToMinutes(options.departTime) + c.gap * (options.dwellMinutes + 15);
    const delta = Math.abs(placeholderMinutes - 13 * 60);
    if (delta < bestDeltaFromMidday) {
      bestDeltaFromMidday = delta;
      bestGap = c.gap;
    }
  }
  return bestGap;
}

function insertAt(day: DayBuild, stop: WorkingStop, gap: number): void {
  day.order.splice(gap, 0, stop);
}

/** Recomputes real arrival/departure using legMinutes; returns null when any
 *  leg is missing (legMinutes had no basis to compute it) so the caller can
 *  decide whether that's still acceptable rather than silently proceeding. */
function walkSchedule(
  day: DayBuild,
  options: PlannerOptions,
  legMinutes: LegMinutesFn,
): {
  stops: PlannedStop[];
  driveMinutesTotal: number;
  driveEstimateAvailable: boolean;
  maxLegMinutes: number;
  overnight: boolean;
  conflicts: string[];
} {
  let clock = hhmmToMinutes(options.departTime);
  let prevPoint: { lat: number; lng: number } = day.start;
  let driveMinutesTotal = 0;
  let driveEstimateAvailable = true;
  let maxLegMinutes = 0;
  let overnight = false;
  let lunchTaken = false;
  const stops: PlannedStop[] = [];
  const conflicts: string[] = [];

  for (const s of day.order) {
    const leg = legMinutes(prevPoint, s);
    const driveMinutes = leg?.minutes ?? null;
    const driveMiles = leg?.miles ?? null;
    if (leg) {
      driveMinutesTotal += leg.minutes;
      maxLegMinutes = Math.max(maxLegMinutes, leg.minutes);
      if (leg.estimated) driveEstimateAvailable = false;
      if (leg.minutes > 120) overnight = true;
    } else {
      driveEstimateAvailable = false;
    }

    const naturalArrive = clock + (driveMinutes ?? 0);

    // A stated time is a fixed anchor (rule 0.5): the stop is shown arriving
    // exactly then, everything before it built around getting there, not
    // the other way around. When the natural drive-based arrival would run
    // past the promise, that's a real conflict, surfaced, never hidden by
    // quietly sliding the promised time later.
    let arriveMinutes: number;
    if (s.statedTimeIso !== null) {
      arriveMinutes = laClockMinutesFromIso(s.statedTimeIso);
      if (naturalArrive > arriveMinutes) {
        conflicts.push(`the drive to ${s.name} runs past its ${minutesToHHMM(arriveMinutes)} promise`);
      }
    } else {
      arriveMinutes = naturalArrive;
    }

    let hoursNote: string | null = null;

    const hoursUnknown = !s.businessHours || Object.keys(s.businessHours).length === 0;
    if (hoursUnknown) {
      hoursNote = "hours unknown";
    } else if (s.statedTimeIso === null) {
      // Only push a candidate/backlog stop off a closed arrival. A timed
      // anchor's own stated time is a promise, never overridden by hours.
      const push = pushToOpenWindow(s.businessHours, day.date, arriveMinutes);
      if (push.state === "pushed") {
        hoursNote = "pushed to opening time";
        arriveMinutes = push.to;
      } else if (push.state === "closed_today") {
        hoursNote = "closed at the planned arrival time";
      }
    }

    const departMinutes = arriveMinutes + options.dwellMinutes;

    // One flat lunch block, taken once, after whichever stop's arrival is
    // closest to midday. No location is invented for it (rule 0: a meal is
    // only a real waypoint when Juan states one); this only holds the clock.
    let clockAfter = departMinutes;
    if (!lunchTaken && arriveMinutes >= 11 * 60 && arriveMinutes <= 14 * 60) {
      clockAfter += options.lunchMinutes;
      lunchTaken = true;
    }

    stops.push({
      accountId: s.accountId,
      name: s.name,
      lat: s.lat,
      lng: s.lng,
      kind: s.kind,
      arrive: minutesToHHMM(arriveMinutes),
      depart: minutesToHHMM(departMinutes),
      driveFromPrevMinutes: driveMinutes === null ? null : Math.round(driveMinutes),
      driveFromPrevMiles: driveMiles === null ? null : Math.round(driveMiles * 10) / 10,
      driveEstimated: leg?.estimated ?? true,
      why: s.reason,
      quote: s.quote,
      statedTime: s.statedTimeIso,
      hoursNote,
      mapsUrl: appleMapsUrl(s),
      directiveId: s.directiveId,
    });

    clock = clockAfter;
    prevPoint = s;
  }

  return { stops, driveMinutesTotal, driveEstimateAvailable, maxLegMinutes, overnight, conflicts };
}

function dayElapsedMinutes(day: DayBuild, options: PlannerOptions, legMinutes: LegMinutesFn): number {
  const { stops } = walkSchedule(day, options, legMinutes);
  if (stops.length === 0) return 0;
  const last = stops[stops.length - 1];
  return hhmmToMinutes(last.depart) - hhmmToMinutes(options.departTime);
}

/**
 * Walks one day's already-decided stop order into a displayable
 * `PlannedDay`, warnings included. Exported so propose.ts's refine pass can
 * re-run just this step with real (OSRM) drive minutes once buildWeekPlan
 * has already settled which stops go on which day and in what order, rather
 * than repeating the insertion search with the expensive drive source.
 */
export function scheduleDay(
  input: { date: string; start: PlanEndpoint; end: PlanEndpoint; order: PlanWorkingStop[] },
  options: PlannerOptions,
  legMinutes: LegMinutesFn,
): PlannedDay {
  const build: DayBuild = { date: input.date, start: input.start, end: input.end, order: input.order, warnings: [] };
  const { stops, driveMinutesTotal, driveEstimateAvailable, maxLegMinutes, overnight, conflicts } = walkSchedule(build, options, legMinutes);
  const warnings = [...build.warnings, ...conflicts];
  if (maxLegMinutes > options.maxDriveLegMinutes) {
    warnings.push(`a leg on this day is estimated over the ${Math.round(options.maxDriveLegMinutes / 60)}h cap`);
  }
  if (input.order.length > options.maxStopsPerDay) {
    warnings.push(`${input.order.length} stops today, above the usual ${options.maxStopsPerDay}`);
  }
  return {
    date: input.date,
    stops,
    overnight,
    driveMinutesTotal: Math.round(driveMinutesTotal),
    driveEstimateAvailable,
    warnings,
  };
}

export function buildWeekPlan(input: {
  days: { date: string; start: PlanEndpoint; end: PlanEndpoint }[];
  /** Every geocoded, eligible account an anchor or a due candidate could
   *  reference, keyed by id. Anchors look themselves up here rather than in
   *  `candidates`, since a return-visit account isn't necessarily in this
   *  week's due/priority pool. */
  accountsById: Map<string, PlanAccount>;
  candidates: PlanAccount[];
  anchors: PlanAnchor[];
  usedAccountIds: Set<string>;
  legMinutes: LegMinutesFn;
  options: PlannerOptions;
}): ProposedWeek {
  const { days, accountsById, candidates, anchors, usedAccountIds, legMinutes, options } = input;

  const builds = new Map<string, DayBuild>(
    days.map((d) => [d.date, { date: d.date, start: d.start, end: d.end, order: [], warnings: [] }]),
  );

  const anchorAccountIds = new Set(anchors.map((a) => a.accountId));

  // --- seat every anchor on its own date: timed ones first, in time order,
  // then untimed (backlog) ones inserted around them by cheapest gap. An
  // anchor is never skipped for capacity or the 3h cap; a day that can't
  // truly fit it says so in warnings instead of dropping it.
  for (const date of builds.keys()) {
    const build = builds.get(date)!;
    const dayAnchors = anchors.filter((a) => a.date === date && accountsById.has(a.accountId));
    const timed = dayAnchors
      .filter((a) => a.statedTimeIso !== null)
      .sort((a, b) => laClockMinutesFromIso(a.statedTimeIso!) - laClockMinutesFromIso(b.statedTimeIso!));
    const untimed = dayAnchors.filter((a) => a.statedTimeIso === null);

    for (const a of timed) {
      const src = accountsById.get(a.accountId)!;
      build.order.push({
        accountId: a.accountId,
        name: src.name,
        lat: src.lat,
        lng: src.lng,
        kind: "anchor",
        businessHours: src.businessHours,
        reason: a.reason,
        quote: a.quote,
        statedTimeIso: a.statedTimeIso,
        directiveId: a.directiveId,
      });
    }
    for (const a of untimed) {
      const src = accountsById.get(a.accountId)!;
      const stop: WorkingStop = {
        accountId: a.accountId,
        name: src.name,
        lat: src.lat,
        lng: src.lng,
        kind: "return",
        businessHours: src.businessHours,
        reason: a.reason,
        quote: a.quote,
        statedTimeIso: null,
        directiveId: a.directiveId,
      };
      const gap = chooseGap(build, stop, options);
      insertAt(build, stop, gap);
    }
  }

  // --- due accounts: geography before priority. Sorted by score so a tie in
  // cost favors whoever is more due, but the day itself is always chosen by
  // whichever costs the least to add, across every day at once.
  const due = candidates
    .filter((c) => !usedAccountIds.has(c.id) && !anchorAccountIds.has(c.id))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  for (const c of due) {
    const stop: WorkingStop = {
      accountId: c.id,
      name: c.name,
      lat: c.lat,
      lng: c.lng,
      kind: "due",
      businessHours: c.businessHours,
      reason: c.reason,
      quote: null,
      statedTimeIso: null,
      directiveId: null,
    };

    let bestDate: string | null = null;
    let bestGap = 0;
    let bestCost = Infinity;

    for (const [date, build] of builds) {
      if (build.order.length >= options.maxStopsPerDay) continue;
      if (dayElapsedMinutes(build, options, legMinutes) >= options.maxDayMinutes) continue;

      const gap = chooseGap(build, stop, options);
      const trial: DayBuild = { ...build, order: [...build.order] };
      insertAt(trial, stop, gap);

      const { maxLegMinutes, stops } = walkSchedule(trial, options, legMinutes);
      if (maxLegMinutes > options.maxDriveLegMinutes) continue;
      const last = stops[stops.length - 1];
      if (hhmmToMinutes(last.depart) - hhmmToMinutes(options.departTime) > options.maxDayMinutes) continue;
      const inserted = stops.find((s) => s.accountId === c.id);
      if (inserted?.hoursNote === "closed at the planned arrival time") continue;

      const cost = gapCosts(build, stop).find((g) => g.gap === gap)!.costMiles;
      if (cost < bestCost) {
        bestCost = cost;
        bestDate = date;
        bestGap = gap;
      }
    }

    if (bestDate) {
      insertAt(builds.get(bestDate)!, stop, bestGap);
    }
  }

  const plannedDays: PlannedDay[] = [];
  for (const [, build] of builds) {
    plannedDays.push(scheduleDay(build, options, legMinutes));
  }

  return { days: plannedDays, unroutable: [] };
}
