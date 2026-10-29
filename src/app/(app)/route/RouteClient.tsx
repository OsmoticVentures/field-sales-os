"use client";

/**
 * Route, from the browser. One field day at a time: stops routed on the
 * real road network (OSRM, the source app's own 1.35 free-flow factor, plus
 * a time-of-day traffic shape for the schedule), lunch and hotel as real
 * stops that consume clock time, business hours as a hard constraint that
 * only ever pushes an arrival forward within the same day, and the stops
 * that will not fit named before the day starts.
 *
 * Adapted from the NutriBiotic OS's map/page.tsx, MapScreen.tsx and
 * RoutePanel.tsx. The list is the working surface (44px buttons, readable
 * at a red light); AccountsMap.tsx above it draws the whole territory,
 * its filters and pin card, plus the day's own shape, on a vanilla
 * google.maps canvas, no map dependency added.
 */

import Link from "next/link";
import { Geolocation } from "@capacitor/geolocation";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { apiFetch, getJson, keepJson, peekJson, peekStoredJson, warmJson } from "@/lib/core/api";
import { useUndoWindow } from "@/lib/core/undo";
import { loadGoogleMaps } from "@/lib/shared/google-maps-loader";
import { Ico, SuccessNote, ghostBtn, inputCls } from "@/lib/core/ui";
import { AccountsMap } from "./AccountsMap";
import { dayLabel, defaultActiveDay, laTodayIso, planningHorizonDates } from "@/lib/features/route/field-week";
import { pushToOpenWindow, hoursStatusNow } from "@/lib/features/route/hours";
import { cheapestGap, haversineMatrix, haversineMiles, optimizedStopOrder, type Matrix } from "@/lib/features/route/route-optimize";
import { BAND_STYLE, driveBand, likelyDriveMinutes } from "@/lib/features/route/traffic";
import { CUSTOM_STOP_LABEL, DEPART_KEY, FINISH_BY_MINUTES, LUNCH_OFF, SDR_KEPT, calendarBaseKey, calendarChoiceKey, lunchDue, movedToSdr, sdrMovedKey } from "@/lib/features/route/types";
import { calendarDay, placeByTime, reconcileCalendar, type CalendarHold } from "@/lib/features/route/calendar";
import type {
  CalendarEvent,
  CallEntry,
  CustomStop,
  DriveLeg,
  RouteAccount,
  RouteDraftEntry,
  RouteEndpoint,
  RouteSchedulePrefs,
  RouteStopView,
} from "@/lib/features/route/types";
import { AddStop } from "./AddStop";
import { ReturnSuggestions } from "./ReturnSuggestions";
import { DayMoveMenu, RowIco } from "./RowControls";
import { HUBSPOT_COMPANY_URL, lastTouchLabel } from "@/lib/features/prospect/format";
import type { Draft } from "@/lib/features/outbound/dal";
import { OpenEmailButtons } from "@/lib/features/outbound/open-email";
import { useAccountPanel } from "../account/[id]/useAccountPanel";

type StatePayload = {
  ok: boolean;
  error?: string;
  days: string[];
  activeDay: string;
  home: RouteEndpoint | null;
  prefs: RouteSchedulePrefs;
  accounts: RouteAccount[];
  startByDay: Record<string, RouteEndpoint>;
  endByDay: Record<string, RouteEndpoint>;
  draft: Record<string, RouteDraftEntry[]>;
  calls: Record<string, CallEntry[]>;
  done: Record<string, string[]>;
  times: Record<string, Record<string, string>>;
  /** Google Calendar by day, from the Mac. */
  calendar?: Record<string, CalendarEvent[]>;
  /** The saved route's fingerprint, compared by the sync below. */
  version?: string;
  /** Stops a visit or meeting was logged for that day, marked done by it. */
  logged?: Record<string, string[]>;
  /** The pending Outbound email for a logged stop's account, by account id. */
  emails?: Record<string, Draft>;
};

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

/**
 * Two devices, one route. Every save counts itself here so the sync never
 * paints a read taken before a save over the save; a refused or unsent save
 * is said in red on the screen and the route goes back to what is saved.
 */
const routeSync: {
  version: string;
  inFlight: number;
  saves: number;
  failed: (msg: string) => void;
  saved: () => void;
  resync: () => void;
} = {
  version: "",
  inFlight: 0,
  saves: 0,
  failed: () => {},
  saved: () => {},
  resync: () => {},
};
const SYNC_MS = 30_000;

async function postJson<T>(path: string, body: unknown): Promise<T> {
  routeSync.inFlight++;
  routeSync.saves++;
  try {
    const res = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": newKey() },
      body: JSON.stringify(body),
    });
    const j = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
    if (!res.ok || !j || j.ok === false) throw new Error(j?.error ?? "Couldn't save that change.");
    routeSync.saved();
    return j;
  } catch (e) {
    const msg = e instanceof TypeError ? "No signal. That change didn't save." : e instanceof Error ? e.message : "Couldn't save that change.";
    routeSync.failed(msg);
    throw e;
  } finally {
    routeSync.inFlight--;
    // The save moved the version: read it now rather than on the next tick.
    if (routeSync.inFlight === 0) routeSync.resync();
  }
}

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (Number.isFinite(h) ? h : 9) * 60 + (Number.isFinite(m) ? m : 30);
}
/** 12-hour wall clock for display, e.g. "2:05 PM". Scheduling itself works
 *  in minutes-of-day throughout; this only formats for a human. */
function clock(mins: number): string {
  const t = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h24 = Math.floor(t / 60);
  const period = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(t % 60).padStart(2, "0")} ${period}`;
}
function duration(mins: number): string {
  const m = Math.round(mins);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m} min`;
}
function usd(n: number | null): string | null {
  if (n === null || n === undefined) return null;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function monthYear(iso: string | null): string | null {
  if (!iso) return null;
  const [y, m] = iso.split("-");
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const name = MONTHS[Number(m) - 1];
  return name ? `${name} ${y}` : iso;
}
function appleMapsUrl(p: { address?: string | null; lat: number; lng: number }): string {
  const daddr = p.address ? encodeURIComponent(p.address) : `${p.lat},${p.lng}`;
  return `https://maps.apple.com/?daddr=${daddr}`;
}
function fullAddress(a: RouteAccount): string {
  return [a.street, a.city, a.state].filter(Boolean).join(", ");
}
/** One Apple Maps URL for the whole day: last stop is the destination, the rest ride along as waypoints. */
function appleMapsRouteUrl(stops: { lat: number; lng: number }[]): string {
  return `https://maps.apple.com/?daddr=${stops.map((s) => `${s.lat},${s.lng}`).join("+to:")}`;
}
function prettyPhone(value: string): string {
  const m = value.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : value;
}
function prettyUrl(value: string): string {
  return value.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}
/** A is the most potential; no tier reads as the least. */
const tierRank = (t: RouteAccount["tier"]) => (t ? "ABCDEFG".indexOf(t) : 7);
function absoluteUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

type ScheduleRow = { arrive: number; leave: number; stay: number };
type Schedule = {
  rows: ScheduleRow[];
  finish: number;
  toFirst: DriveLeg | null;
  end: DriveLeg | null;
  priced: DriveLeg[];
  missedAnchors: Set<string>;
  closedToday: Set<string>;
  /** Where the day's Lunch stop goes, after the stop at this index, while
   *  the day has none yet (RouteDay then places it there). */
  lunch: { after: number } | null;
};

/** Priced forward, one pass: a leg's cost depends on when it departs, and
 *  that depends on every leg before it. Anchors (a stated time) and business
 *  hours (a hard constraint) both only ever push the clock FORWARD, never
 *  rewind it, and a stop that cannot be reached open is named rather than
 *  scheduled anyway. */
type AreasPayload = { ok: boolean; areas?: { id: string; label: string }[]; lastTouchById?: Record<string, string> };
const areaLabelMap = (j: AreasPayload | null | undefined) => new Map((j?.areas ?? []).map((a) => [a.id, a.label]));

function buildSchedule(
  stops: RouteStopView[],
  legs: DriveLeg[],
  hasStart: boolean,
  hasEnd: boolean,
  prefs: RouteSchedulePrefs,
  dayISO: string,
  anchors: Record<string, string>,
  lunchOff: boolean,
  /** The whole day, done stops too: a Lunch already eaten still counts. */
  dayStops: RouteStopView[] = stops,
  /** Calendar time with no place: no stop is put inside it. */
  holds: CalendarHold[] = [],
): Schedule {
  const price = (leg: DriveLeg | undefined, atMinutes: number): DriveLeg | null => {
    if (!leg) return null;
    const at = new Date(`${dayISO}T00:00:00`);
    at.setMinutes(at.getMinutes() + atMinutes);
    return { ...leg, minutes: likelyDriveMinutes(leg.freeFlowMinutes, at) };
  };

  const priced: DriveLeg[] = new Array(legs.length);
  const depart = minutesOfDay(prefs.depart);
  const toFirst = hasStart ? price(legs[0], depart) : null;
  if (hasStart && toFirst) priced[0] = toFirst;

  const betweenOffset = hasStart ? 1 : 0;
  const between = legs.slice(betweenOffset, legs.length - (hasEnd ? 1 : 0));

  const rows: ScheduleRow[] = [];
  const missedAnchors = new Set<string>();
  const closedToday = new Set<string>();
  let t = depart + (toFirst?.minutes ?? 0);
  const lunchStop = lunchOff || dayStops.some((s) => s.type === "custom" && s.custom.kind === "lunch");
  let lunch: Schedule["lunch"] = null;

  stops.forEach((s, i) => {
    if (i > 0) {
      const hop = price(between[i - 1], t);
      if (hop) priced[betweenOffset + i - 1] = hop;
      t += hop?.minutes ?? 0;
    }
    // Lunch follows the route unless a time was stated for it ("noon in the valley").
    const anchor = anchors[s.id];
    if (anchor) {
      const at = minutesOfDay(anchor);
      if (at >= t) t = at;
      else missedAnchors.add(s.id);
    }
    if (s.type === "account" && s.account.business_hours) {
      const push = pushToOpenWindow(s.account.business_hours, dayISO, t);
      if (push.state === "pushed") t = push.to;
      else if (push.state === "closed_today") closedToday.add(s.id);
    }
    const kind = s.type === "custom" ? s.custom.kind : null;
    const stay =
      s.type === "custom" && typeof s.custom.minutes === "number"
        ? s.custom.minutes
        : kind === "lunch"
          ? prefs.lunchMinutes
          : kind === "hotel"
            ? 0
            : prefs.dwellMinutes;
    // A stop with a stated time is where that time is spent (the noon call
    // taken at the valley lunch), so a hold never pushes it.
    if (kind !== "event" && !anchor) {
      for (const h of holds) if (t < h.end && t + stay > h.start) t = h.end;
    }
    rows.push({ arrive: t, leave: t + stay, stay });
    t += stay;
    if (!lunch && !lunchStop && prefs.lunchMinutes > 0 && lunchDue(t)) {
      lunch = { after: i };
      t += prefs.lunchMinutes;
    }
  });

  const endLeg = hasEnd ? price(legs[legs.length - 1], t) : null;
  if (hasEnd && endLeg) priced[legs.length - 1] = endLeg;
  for (let i = 0; i < legs.length; i++) if (!priced[i]) priced[i] = legs[i];

  return { rows, finish: t + (endLeg?.minutes ?? 0), toFirst, end: endLeg, priced, missedAnchors, closedToday, lunch };
}

const dayBtn = (active: boolean) =>
  `min-h-11 shrink-0 rounded-full px-4 py-2 text-[13px] font-medium transition-transform active:scale-[0.97] ${
    active ? "glass-dark" : "glass text-[#3D4A44]"
  }`;
/** ghostBtn plus the icon+label layout most row actions need; composed, not
 *  a fork, so the base still comes from lib/core/ui. */
const iconBtn = `${ghostBtn} inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[13px] font-medium text-[#3D4A44]`;
/** Square 44px icon-only row control. */
const sqBtn = `${ghostBtn} inline-flex min-w-11 items-center justify-center px-0 py-0`;

/** A kept copy of the route, read against today: the days and the open day
 *  are worked out again, since the copy may be from yesterday. */
function fromCopy(copy: StatePayload | undefined): StatePayload | null {
  if (!copy?.ok) return null;
  const days = planningHorizonDates();
  return { ...copy, days, activeDay: defaultActiveDay(copy.draft, days) };
}
const STATE_PATH = "/api/route/state";

export function RouteClient() {
  // The route paints from what is on the phone (this visit's last read, else
  // the copy kept on the device), then the fresh read replaces it. Only the
  // day stays put if the rep already picked one.
  const [data, setData] = useState<StatePayload | null>(() => fromCopy(peekJson<StatePayload>(STATE_PATH)));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<string | null>(() => data?.activeDay ?? null);
  const shown = useRef(data !== null);
  // Set once a server answer is on screen; only then is the screen's own
  // state written back as the phone copy.
  const fresh = useRef(false);

  useEffect(() => {
    // Everything the screen will ask for, started together rather than as
    // each piece mounts: the map's own read, the return suggestions, and
    // the Maps script.
    warmJson("/api/route/map");
    warmJson("/api/route/returns");
    const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
    if (key) void loadGoogleMaps(key).catch(() => {});

    let live = true;
    // A cold open: the copy on the phone's disk paints the moment it is read.
    if (!shown.current) {
      void peekStoredJson<StatePayload>(STATE_PATH).then((copy) => {
        const kept = fromCopy(copy);
        if (!live || !kept || shown.current) return;
        shown.current = true;
        setData(kept);
        setActiveDay((d) => d ?? kept.activeDay);
      });
    }
    const read = () => {
      const savesAtStart = routeSync.saves;
      getJson<StatePayload>(STATE_PATH)
        .then((j) => {
          if (!live) return;
          if (!j.ok) {
            if (!shown.current) setLoadError("Couldn't load the route.");
            return;
          }
          // The rep changed the route while this read was out: it may
          // predate the change, so read again rather than paint it.
          if (routeSync.saves !== savesAtStart || routeSync.inFlight > 0) {
            setTimeout(() => live && read(), 400);
            return;
          }
          routeSync.version = j.version ?? "";
          shown.current = true;
          fresh.current = true;
          setData(j);
          setActiveDay((d) => (d && j.days.includes(d) ? d : j.activeDay));
        })
        // No signal: a painted copy stays; with nothing to show, say so.
        .catch(() => live && !shown.current && setLoadError("Couldn't load the route."));
    };
    read();
    return () => {
      live = false;
    };
  }, []);

  // What the screen shows after the rep's own changes is the next open's copy.
  useEffect(() => {
    if (!data || !fresh.current) return;
    const t = setTimeout(() => keepJson(STATE_PATH, data), 800);
    return () => clearTimeout(t);
  }, [data]);

  // The route another device changed shows up here: on resume, on focus,
  // and every 30 seconds while the screen is open. A tick where nothing
  // moved costs a few bytes; a moved route reads the route, not the book.
  useEffect(() => {
    let live = true;
    let force = false;
    async function tick() {
      if (!live || routeSync.inFlight > 0 || document.visibilityState !== "visible") return;
      const savesAtStart = routeSync.saves;
      const v = force ? "" : routeSync.version;
      force = false;
      try {
        const res = await apiFetch(`/api/route/sync?v=${encodeURIComponent(v)}`, { cache: "no-store" });
        const j = (await res.json()) as Partial<StatePayload> & { ok: boolean; same?: boolean; version?: string };
        // A save started while this read was out: the read may predate it.
        if (!live || !j.ok || routeSync.saves !== savesAtStart || routeSync.inFlight > 0) return;
        routeSync.version = j.version ?? routeSync.version;
        if (j.same) return;
        setData((prev) => {
          if (!prev) return prev;
          const known = new Set(prev.accounts.map((a) => a.id));
          const unknown = Object.values(j.draft ?? {}).some((es) => es.some((e) => typeof e === "string" && !known.has(e)));
          // A stop for an account this device has not loaded: read the whole screen again.
          if (unknown) {
            getJson<StatePayload>("/api/route/state").then((full) => live && full.ok && setData(full)).catch(() => {});
            return prev;
          }
          return {
            ...prev,
            draft: j.draft ?? prev.draft,
            calls: j.calls ?? prev.calls,
            done: j.done ?? prev.done,
            times: j.times ?? prev.times,
            calendar: j.calendar ?? prev.calendar,
            startByDay: j.startByDay ?? prev.startByDay,
            endByDay: j.endByDay ?? prev.endByDay,
            version: j.version,
          };
        });
      } catch {
        // No signal: the next tick or resume tries again.
      }
    }
    routeSync.resync = () => void tick();
    routeSync.failed = (msg) => {
      if (!live) return;
      setSaveError(msg);
      force = true;
      setTimeout(() => void tick(), 0);
    };
    routeSync.saved = () => {
      if (live) setSaveError(null);
    };
    const onVisible = () => void tick();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("online", onVisible);
    const timer = setInterval(() => void tick(), SYNC_MS);
    return () => {
      live = false;
      routeSync.resync = () => {};
      routeSync.failed = () => {};
      routeSync.saved = () => {};
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("online", onVisible);
      clearInterval(timer);
    };
  }, []);

  if (loadError) return <p className="text-[14px] text-[#8A2E2E]">{loadError}</p>;
  if (!data || !activeDay) {
    return (
      <div className="flex w-full flex-col gap-3">
        <div className="h-9 w-full animate-pulse rounded-md bg-[#EDEBE3]" />
        <div className="h-40 w-full animate-pulse rounded-md bg-[#EDEBE3]" />
      </div>
    );
  }

  // data is guaranteed non-null past the guard above; RouteDay's functional
  // setData updates never see the null branch React's own Dispatch type allows.
  const setDataForDay = setData as unknown as (next: StatePayload | ((prev: StatePayload) => StatePayload)) => void;
  return (
    <>
      {saveError && <p className="text-[14px] text-[#8A2E2E]">{saveError} The route shows what is saved.</p>}
      <RouteDay data={data} setData={setDataForDay} activeDay={activeDay} setActiveDay={setActiveDay} />
    </>
  );
}

function RouteDay({
  data,
  setData,
  activeDay,
  setActiveDay,
}: {
  data: StatePayload;
  setData: (next: StatePayload | ((prev: StatePayload) => StatePayload)) => void;
  activeDay: string;
  setActiveDay: (d: string) => void;
}) {
  const days = data.days;
  const accountPanel = useAccountPanel();
  const accountsById = useMemo(() => new Map(data.accounts.map((a) => [a.id, a])), [data.accounts]);

  const draft = data.draft[activeDay] ?? [];
  const calls = data.calls[activeDay] ?? [];
  const doneIds = useMemo(() => new Set(data.done[activeDay] ?? []), [data.done, activeDay]);
  const stopTimes = useMemo(() => data.times[activeDay] ?? {}, [data.times, activeDay]);
  const lunchOff = stopTimes[LUNCH_OFF] === "off";
  const dayEvents = useMemo(() => data.calendar?.[activeDay] ?? [], [data.calendar, activeDay]);
  const calDay = useMemo(() => calendarDay(dayEvents, stopTimes), [dayEvents, stopTimes]);

  // Area ids read as their names ("hollywood-pasadena" is Hollywood - Pasadena).
  const [areaLabels, setAreaLabels] = useState(() => areaLabelMap(peekJson<AreasPayload>("/api/route/map")));
  const [lastTouchById, setLastTouchById] = useState<Record<string, string>>(() => peekJson<AreasPayload>("/api/route/map")?.lastTouchById ?? {});
  useEffect(() => {
    let live = true;
    getJson<AreasPayload>("/api/route/map")
      .then((j) => {
        if (!live) return;
        setAreaLabels(areaLabelMap(j));
        setLastTouchById(j.lastTouchById ?? {});
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const stops = useMemo<RouteStopView[]>(
    () =>
      draft
        .map((e): RouteStopView | null => {
          if (typeof e !== "string") return { id: e.id, lat: e.lat, lng: e.lng, type: "custom", custom: e };
          const a = accountsById.get(e);
          return a ? { id: a.id, lat: a.lat, lng: a.lng, type: "account", account: a } : null;
        })
        .filter((s): s is RouteStopView => s !== null),
    [draft, accountsById],
  );
  const inRoute = useMemo(() => new Set(stops.map((s) => s.id)), [stops]);

  const dayIndex = days.indexOf(activeDay);
  const prevDay = dayIndex > 0 ? days[dayIndex - 1] : null;
  const [myLoc, setMyLoc] = useState<RouteEndpoint | null>(null);
  useEffect(() => {
    locateMe().then(setMyLoc);
  }, []);
  // Where the rep is right now only matters on today's route. A future day
  // is planned: it leaves from the day before's end, or home, at 9.
  const here = activeDay === laTodayIso() ? myLoc : null;
  const startFallback = here ?? (prevDay ? data.endByDay[prevDay] : null) ?? data.home;
  const start = data.startByDay[activeDay] ?? startFallback;
  const end = data.endByDay[activeDay] ?? here ?? data.home;

  // Today, once a stop is done, the clock runs from here and now: the stops
  // left are routed from where the rep is (or the last stop made), so the
  // ETAs after it are the real ones, not the morning's plan.
  const live = activeDay === laTodayIso() && stops.some((s) => doneIds.has(s.id));
  // A stop moved to SDR stays on the list, crossed off, but is not driven to.
  const movedIds = useMemo(() => new Set(stops.filter((s) => movedToSdr(stopTimes, s.id)).map((s) => s.id)), [stops, stopTimes]);
  const routed = useMemo(
    () => stops.filter((s) => !movedIds.has(s.id) && !(live && doneIds.has(s.id))),
    [live, stops, doneIds, movedIds],
  );
  const routedIndex = useMemo(() => new Map(routed.map((s, i) => [s.id, i])), [routed]);
  const stopNumber = useMemo(
    () => new Map(stops.filter((s) => !movedIds.has(s.id)).map((s, i) => [s.id, i + 1])),
    [stops, movedIds],
  );
  const routeStart = useMemo<RouteEndpoint | null>(() => {
    if (!live) return start;
    if (myLoc) return myLoc;
    const lastDone = [...stops].reverse().find((s) => doneIds.has(s.id));
    if (!lastDone) return start;
    const label = lastDone.type === "account" ? lastDone.account.name : lastDone.custom.label;
    return { label, address: "", lat: lastDone.lat, lng: lastDone.lng };
  }, [live, myLoc, stops, doneIds, start]);

  // A field day leaves at the saved time (9); today never leaves in the past.
  const departFor = (day: string) => {
    const planned = data.times[day]?.[DEPART_KEY] ?? data.prefs.depart;
    if (day !== laTodayIso()) return planned;
    const now = nowHHMM();
    return now > planned ? now : planned;
  };
  const [depart, setDepart] = useState(() => departFor(activeDay));
  const [departDay, setDepartDay] = useState(activeDay);
  if (departDay !== activeDay) {
    setDepartDay(activeDay);
    setDepart(departFor(activeDay));
  }
  const [prefs, setPrefsLocal] = useState<RouteSchedulePrefs>({ ...data.prefs, depart });
  // Saved prefs or a new departure time reset the local prefs, during render.
  const [prefsFrom, setPrefsFrom] = useState({ prefs: data.prefs, depart });
  if (prefsFrom.prefs !== data.prefs || prefsFrom.depart !== depart) {
    setPrefsFrom({ prefs: data.prefs, depart });
    setPrefsLocal({ ...data.prefs, depart });
  }

  const [busy, setBusy] = useState(false);
  const [legs, setLegs] = useState<DriveLeg[] | null>(null);
  const [coords, setCoords] = useState<[number, number][] | null>(null);
  const pointCount = routed.length === 0 ? 0 : (routeStart ? 1 : 0) + routed.length + (end ? 1 : 0);
  const [legState, setLegState] = useState<"loading" | "ok" | "unavailable">(() => (pointCount < 2 ? "ok" : "loading"));
  const [confirmingDone, setConfirmingDone] = useState<Set<string>>(new Set());
  const { arm: armDone, undo: undoDone } = useUndoWindow();
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);

  const mapBoxRef = useRef<HTMLDivElement | null>(null);

  // Drag to reorder: the dragged row dims and an insertion line shows where it
  // lands; the array reorders once, on drop.
  const listRef = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<{ id: string; dropIndex: number } | null>(null);
  function dropIndexAt(clientY: number, excludeId: string): number {
    const items = listRef.current ? Array.from(listRef.current.querySelectorAll<HTMLLIElement>("li[data-stop-id]")) : [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].dataset.stopId === excludeId) continue;
      const rect = items[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return items.length;
  }
  function handleGripDown(e: PointerEvent<HTMLButtonElement>, id: string, index: number) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, dropIndex: index });
  }
  function handleGripMove(e: PointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    e.preventDefault();
    const next = dropIndexAt(e.clientY, drag.id);
    if (next !== drag.dropIndex) setDrag({ ...drag, dropIndex: next });
  }
  function handleGripUp(e: PointerEvent<HTMLButtonElement>) {
    if (!drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const ids = stops.map((s) => s.id);
    const from = ids.indexOf(drag.id);
    const filtered = ids.filter((id) => id !== drag.id);
    let insertAt = drag.dropIndex;
    if (from !== -1 && from < drag.dropIndex) insertAt -= 1;
    insertAt = Math.max(0, Math.min(filtered.length, insertAt));
    filtered.splice(insertAt, 0, drag.id);
    setDrag(null);
    if (filtered.some((id, i) => id !== ids[i])) reorder(filtered);
  }

  const pathKey = useMemo(
    () =>
      [
        routeStart ? `s:${routeStart.lat},${routeStart.lng}` : "s:-",
        ...routed.map((s) => `${s.lat},${s.lng}`),
        end ? `e:${end.lat},${end.lng}` : "e:-",
      ].join("|"),
    [routed, routeStart, end],
  );

  /* A new path clears or marks the drive legs during render; the effect
     below only fetches them. */
  const [legsFor, setLegsFor] = useState(pathKey);
  if (legsFor !== pathKey) {
    setLegsFor(pathKey);
    if (pointCount < 2) {
      setLegs(null);
      setCoords(null);
      setLegState("ok");
    } else {
      setLegState("loading");
    }
  }

  useEffect(() => {
    if (pointCount < 2) return;
    const points = [...(routeStart ? [routeStart] : []), ...routed, ...(end ? [end] : [])];
    let live = true;
    apiFetch("/api/route/drive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points: points.map((p) => ({ lat: p.lat, lng: p.lng })), mode: "legs" }),
    })
      .then((r) => r.json())
      .then((j: { ok: boolean; legs: DriveLeg[] | null; coords?: [number, number][] | null }) => {
        if (!live) return;
        setLegs(j.ok ? j.legs : null);
        setCoords(j.ok ? (j.coords ?? null) : null);
        setLegState(j.ok && j.legs ? "ok" : "unavailable");
      })
      .catch(() => {
        if (live) {
          setLegs(null);
          setCoords(null);
          setLegState("unavailable");
        }
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathKey]);

  const schedule = useMemo(
    () =>
      legs && routed.length > 0
        ? buildSchedule(routed, legs, routeStart !== null, end !== null, prefs, activeDay, stopTimes, lunchOff, stops, calDay.holds)
        : null,
    [legs, routed, routeStart, end, prefs, activeDay, stopTimes, lunchOff, stops, calDay.holds],
  );

  // The calendar's stops follow the calendar: an event with a place goes in
  // at its time, a moved one moves, a deleted one leaves. Past days stay as
  // they were driven.
  useEffect(() => {
    if (activeDay < laTodayIso()) return;
    const next = reconcileCalendar(draft, stopTimes, calDay, dayEvents, (order, timed) =>
      placeByTime(order, timed, pointOfEntry, start, minutesOfDay(stopTimes[DEPART_KEY] ?? data.prefs.depart), prefs.dwellMinutes, timeOfEntry),
    );
    if (next) patchDraftAndTimes(activeDay, next.draft, next.times);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calDay, activeDay, draft]);

  // The day's Lunch stop goes in on its own, right after the stop it falls
  // behind, at that stop's spot and named for its area until a place is
  // picked. Taking it off the day keeps it off (LUNCH_OFF).
  const lunchAfter = schedule?.lunch?.after ?? null;
  // A day of calendar events only (a Saturday errand, a brunch) is not a
  // field day and gets no Lunch stop.
  const fieldDay = stops.some((s) => s.type === "account");
  useEffect(() => {
    if (lunchAfter === null || !fieldDay) return;
    const before = routed[lunchAfter];
    if (!before) return;
    const area = before.type === "account" ? (before.account.area ?? before.account.city) : (before.custom.area ?? null);
    const lunch: CustomStop = {
      id: `custom:${newKey()}`,
      kind: "lunch",
      label: "Lunch",
      address: area ?? "",
      lat: before.lat,
      lng: before.lng,
      pending: true,
      area,
    };
    const at = draft.findIndex((e) => (typeof e === "string" ? e : e.id) === before.id);
    if (at < 0) return;
    patchDraft(activeDay, [...draft.slice(0, at + 1), lunch, ...draft.slice(at + 1)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lunchAfter, activeDay]);

  // A stop with a stated time that the order makes late (a stop added or
  // moved ahead of it) goes back in where its time falls. If it is still late
  // in that order, the day cannot fit everything before it: the lowest
  // potential account ahead of it comes off the drive onto the same day's SDR
  // list, one per pass, until the stated time is kept. Settles: a placement
  // the same rest places the same way is never written twice, and every pass
  // that moves a stop leaves one fewer to move.
  const lateKey = schedule ? [...schedule.missedAnchors].sort().join("|") : "";
  useEffect(() => {
    if (!lateKey || legState !== "ok" || activeDay < laTodayIso()) return;
    const late = new Set(lateKey.split("|"));
    const idOf = (e: RouteDraftEntry) => (typeof e === "string" ? e : e.id);
    const now = activeDay === laTodayIso() ? minutesOfDay(nowHHMM()) : 0;
    const timed = draft
      .filter((e) => late.has(idOf(e)) && !doneIds.has(idOf(e)) && stopTimes[idOf(e)])
      .map((e) => ({ entry: e, at: minutesOfDay(stopTimes[idOf(e)]) }))
      .filter((x) => x.at > now);
    if (timed.length === 0) return;

    const moving = new Set(timed.map((x) => idOf(x.entry)));
    const head = live ? draft.filter((e) => doneIds.has(idOf(e))) : [];
    const rest = draft.filter((e) => !moving.has(idOf(e)) && !head.includes(e));
    const pointOfRouted = (e: RouteDraftEntry) => (movedIds.has(idOf(e)) ? null : pointOfEntry(e));
    const next = [
      ...head,
      ...placeByTime(rest, timed, pointOfRouted, routeStart, minutesOfDay(prefs.depart), prefs.dwellMinutes, timeOfEntry),
    ];
    if (next.length !== draft.length || next.some((e, i) => e !== draft[i])) {
      patchDraft(activeDay, next);
      return;
    }

    // Still late where it falls: the earliest late stop sets the cut.
    const firstLate = Math.min(...timed.map((x) => routedIndex.get(idOf(x.entry)) ?? Infinity));
    const candidates = routed.slice(0, Number.isFinite(firstLate) ? firstLate : 0).filter(
      (r): r is Extract<RouteStopView, { type: "account" }> =>
        r.type === "account" && !doneIds.has(r.id) && !timeOfEntry(r.id) && stopTimes[sdrMovedKey(r.id)] !== SDR_KEPT,
    );
    if (candidates.length === 0) return;
    const pick = [...candidates].sort(
      (x, y) =>
        tierRank(y.account.tier) - tierRank(x.account.tier) ||
        (x.account.trailing_12m_revenue ?? 0) - (y.account.trailing_12m_revenue ?? 0) ||
        (x.account.lifetime_revenue ?? 0) - (y.account.lifetime_revenue ?? 0),
    )[0];
    moveToSdr(pick.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lateKey, legState, pathKey, activeDay]);

  /** Off the day's drive and onto the same day's SDR list as a call. The
   *  stop stays on the list, crossed off, until the rep puts it back. */
  function moveToSdr(id: string) {
    const day = activeDay;
    const key = sdrMovedKey(id);
    const setMark = (value: string) =>
      setData((prev) => {
        const times = { ...(prev.times[day] ?? {}), [key]: value };
        postJson("/api/route/stop-times", { day, times }).catch(() => {});
        return { ...prev, times: { ...prev.times, [day]: times } };
      });
    setMark("");
    postJson<{ ok: boolean; result?: { id?: string } }>("/api/prospect/schedule", {
      account_id: id,
      kind: "call",
      scheduled_date: day,
      priority: "high",
      notes: "Moved off the route to keep a stated time",
    })
      .then((res) => {
        if (res.ok && res.result?.id) setMark(res.result.id);
      })
      .catch(() => {});
  }
  /** Back on the drive; its SDR call is skipped, and it is never moved again
   *  that day. */
  function keepOnRoute(id: string) {
    const sdrId = stopTimes[sdrMovedKey(id)];
    if (sdrId) postJson("/api/prospect/status", { id: sdrId, status: "skipped" }).catch(() => {});
    patchTimes(activeDay, { ...stopTimes, [sdrMovedKey(id)]: SDR_KEPT });
  }

  const shownLegs = schedule?.priced ?? legs;

  async function costMatrix(points: { lat: number; lng: number }[]): Promise<Matrix> {
    try {
      const res = await apiFetch("/api/route/drive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ points, mode: "matrix" }),
      });
      const j = await res.json();
      if (j.ok && j.matrix) return j.matrix as Matrix;
    } catch {
      // fall through to the straight-line fallback below
    }
    return haversineMatrix(points);
  }

  /** A Lunch with no place picked yet sits wherever it falls: moved behind
   *  another stop, it takes that stop's spot and area, so the route bends
   *  there instead of back to where the Lunch first went in. */
  function followLunch(entries: RouteDraftEntry[]): RouteDraftEntry[] {
    return entries.map((e, i) => {
      if (typeof e === "string" || e.kind !== "lunch" || !e.pending || i === 0) return e;
      const prev = entries[i - 1];
      const a = typeof prev === "string" ? accountsById.get(prev) : null;
      if (typeof prev === "string" && !a) return e;
      const lat = a ? a.lat : (prev as CustomStop).lat;
      const lng = a ? a.lng : (prev as CustomStop).lng;
      const area = a ? (a.area ?? a.city ?? null) : ((prev as CustomStop).area ?? null);
      if (lat === e.lat && lng === e.lng) return e;
      return { ...e, lat, lng, address: area ?? e.address, area: area ?? undefined };
    });
  }

  function patchDraft(day: string, raw: RouteDraftEntry[]) {
    const entries = followLunch(raw);
    setData({ ...data, draft: { ...data.draft, [day]: entries } });
    postJson("/api/route/draft", { day, entries }).catch(() => {});
  }
  /** One state update for both, so neither overwrites the other on screen. */
  function patchDraftAndTimes(day: string, entries: RouteDraftEntry[], times: Record<string, string>) {
    setData((prev) => ({ ...prev, draft: { ...prev.draft, [day]: entries }, times: { ...prev.times, [day]: times } }));
    postJson("/api/route/draft", { day, entries }).catch(() => {});
    postJson("/api/route/stop-times", { day, times }).catch(() => {});
  }
  function pointOfEntry(e: RouteDraftEntry): { lat: number; lng: number } | null {
    if (typeof e !== "string") return { lat: e.lat, lng: e.lng };
    const a = accountsById.get(e);
    return a ? { lat: a.lat, lng: a.lng } : null;
  }
  function timeOfEntry(e: RouteDraftEntry): number | null {
    const at = stopTimes[typeof e === "string" ? e : e.id];
    return at && /^\d{1,2}:\d{2}$/.test(at) ? minutesOfDay(at) : null;
  }
  function patchCalls(day: string, next: CallEntry[]) {
    setData({ ...data, calls: { ...data.calls, [day]: next } });
    postJson("/api/route/calls", { day, calls: next }).catch(() => {});
  }
  function patchDone(day: string, next: string[]) {
    setData({ ...data, done: { ...data.done, [day]: next } });
    postJson("/api/route/done", { day, done: next }).catch(() => {});
  }
  function patchTimes(day: string, next: Record<string, string>) {
    setData({ ...data, times: { ...data.times, [day]: next } });
    postJson("/api/route/stop-times", { day, times: next }).catch(() => {});
  }
  function patchPrefs(next: RouteSchedulePrefs) {
    setDepart(next.depart);
    setPrefsLocal(next);
    // The leave time belongs to this day; stay and lunch lengths are saved for every day.
    if (next.depart !== prefs.depart) patchTimes(activeDay, { ...stopTimes, [DEPART_KEY]: next.depart });
    postJson<{ ok: boolean }>("/api/route/prefs", { ...next, depart: data.prefs.depart }).catch(() => {});
  }
  function patchEndpoint(day: string, which: "start" | "end", ep: RouteEndpoint | null) {
    const key = which === "start" ? "startByDay" : "endByDay";
    setData({ ...data, [key]: { ...data[key], ...(ep ? { [day]: ep } : {}) , ...(ep ? {} : Object.fromEntries(Object.entries(data[key]).filter(([d]) => d !== day))) } });
    postJson("/api/route/endpoints", { day, [which]: ep }).catch(() => {});
  }

  async function addEntry(entry: RouteDraftEntry, lat: number, lng: number) {
    if (stops.length === 0) {
      patchDraft(activeDay, [entry]);
      return;
    }
    setBusy(true);
    try {
      const points = [...(start ? [start] : []), ...stops, ...(end ? [end] : []), { lat, lng }];
      const matrix = await costMatrix(points);
      const gap = cheapestGap(matrix, stops.length, start !== null, end !== null);
      const next = [...draft];
      next.splice(gap, 0, entry);
      patchDraft(activeDay, next);
    } finally {
      setBusy(false);
    }
  }

  /** Names the exact day (source's MapScreen.tsx handleAddToRouteOnDay): the
   *  active day keeps addEntry's own cheapest-insertion order; any other day
   *  on the horizon just appends to that day's own draft. */
  function onAddToRouteOnDay(id: string, day: string, lat: number, lng: number) {
    if (day === activeDay) {
      void addEntry(id, lat, lng);
      return;
    }
    const entries = data.draft[day] ?? [];
    if (entries.some((e) => (typeof e === "string" ? e : e.id) === id)) return;
    patchDraft(day, [...entries, id]);
  }

  function removeStop(id: string) {
    const gone = draft.find((e) => typeof e !== "string" && e.id === id);
    if (gone && typeof gone !== "string" && gone.calendarId) {
      // Off this day's route; the event itself stays on the calendar.
      const times = { ...stopTimes, [calendarChoiceKey(gone.calendarId)]: "off" };
      delete times[id];
      patchDraftAndTimes(activeDay, draft.filter((e) => (typeof e === "string" ? e !== id : e.id !== id)), times);
      return;
    }
    if (gone && typeof gone !== "string" && gone.kind === "lunch") patchTimes(activeDay, { ...stopTimes, [LUNCH_OFF]: "off" });
    patchDraft(
      activeDay,
      draft.filter((e) => (typeof e === "string" ? e !== id : e.id !== id)),
    );
  }
  /** A stop's locked time, set or changed on its card: the stop goes where
   *  that time falls in the day and the clock holds it. Clearing it unlocks
   *  the stop, except a calendar event, whose time is the calendar's. */
  function setLockedTime(id: string, hhmm: string | null) {
    const entry = draft.find((e) => (typeof e === "string" ? e === id : e.id === id));
    if (!entry) return;
    const calId = typeof entry !== "string" ? entry.calendarId : undefined;
    if (!hhmm && calId) return;
    if ((stopTimes[id] ?? null) === hhmm) return;
    const times = { ...stopTimes };
    if (calId) {
      const base = calendarBaseKey(calId);
      const calStart = dayEvents.find((e) => e.id === calId)?.start;
      if (calStart && hhmm === calStart) delete times[base];
      else if (calStart) times[base] = calStart;
    }
    if (hhmm) times[id] = hhmm;
    else delete times[id];
    if (!hhmm) {
      patchTimes(activeDay, times);
      return;
    }
    const rest = draft.filter((e) => e !== entry);
    const placed = placeByTime(
      rest,
      [{ entry, at: minutesOfDay(hhmm) }],
      pointOfEntry,
      start,
      minutesOfDay(stopTimes[DEPART_KEY] ?? data.prefs.depart),
      prefs.dwellMinutes,
      timeOfEntry,
    );
    patchDraftAndTimes(activeDay, placed, times);
  }
  function patchCustom(id: string, next: Partial<CustomStop>) {
    patchDraft(
      activeDay,
      draft.map((e) => (typeof e !== "string" && e.id === id ? { ...e, ...next } : e)),
    );
  }
  function reorder(order: string[]) {
    const byId = new Map(draft.map((e) => [typeof e === "string" ? e : e.id, e]));
    patchDraft(activeDay, order.map((id) => byId.get(id)!).filter(Boolean));
  }
  function toggleDone(id: string) {
    if (doneIds.has(id)) {
      patchDone(activeDay, [...doneIds].filter((x) => x !== id));
      return;
    }
    setConfirmingDone((prev) => new Set(prev).add(id));
    const day = activeDay;
    // The note carries Undo; the stop is marked when the window passes.
    armDone(id, () => {
      setConfirmingDone((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      if (day === laTodayIso()) setDepart(nowHHMM());
      setData((prev) => {
        const nextDone = Array.from(new Set([...(prev.done[day] ?? []), id]));
        postJson("/api/route/done", { day, done: nextDone }).catch(() => {});
        return { ...prev, done: { ...prev.done, [day]: nextDone } };
      });
    });
  }
  function undoMarkDone(id: string) {
    if (!undoDone(id)) return;
    setConfirmingDone((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  /** Moves a stop from the active day to another day in one state update:
   *  two sequential setData calls each based on the same stale snapshot
   *  would have the second overwrite the first's removal. */
  function moveStopToDay(id: string, targetDay: string) {
    const entry = draft.find((e) => (typeof e === "string" ? e === id : e.id === id));
    if (!entry) return;
    const fromEntries = draft.filter((e) => (typeof e === "string" ? e !== id : e.id !== id));
    const targetEntries = [...(data.draft[targetDay] ?? []), entry];
    setData((prev) => ({ ...prev, draft: { ...prev.draft, [activeDay]: fromEntries, [targetDay]: targetEntries } }));
    // Sequential: each write reads the whole draft and rewrites it, so two in flight at once can undo each other.
    postJson("/api/route/draft", { day: activeDay, entries: fromEntries })
      .then(() => postJson("/api/route/draft", { day: targetDay, entries: targetEntries }))
      .catch(() => {});
  }
  // Deep link from the widget (?day=&stop=): land on that day, scroll to the
  // stop's row, and mark it on the map.
  const linkRef = useRef<{ day: string | null; stop: string } | null | undefined>(undefined);
  if (linkRef.current === undefined) {
    const q = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
    const stop = q?.get("stop");
    linkRef.current = stop ? { day: q?.get("day") ?? null, stop } : null;
  }
  useEffect(() => {
    const l = linkRef.current;
    if (!l) return;
    if (l.day && l.day !== activeDay && days.includes(l.day)) {
      setActiveDay(l.day);
      return;
    }
    if (!inRoute.has(l.stop)) return;
    linkRef.current = null;
    const row = listRef.current?.querySelector<HTMLLIElement>(`li[data-stop-id="${CSS.escape(l.stop)}"]`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    row?.animate([{ backgroundColor: "#E4EFE8" }, { backgroundColor: "transparent" }], { duration: 1600 });
    setFocus((f) => ({ id: l.stop, n: (f?.n ?? 0) + 1 }));
  }, [activeDay, days, inRoute, setActiveDay]);
  function clearDay() {
    const day = activeDay;
    setData((prev) => ({ ...prev, draft: { ...prev.draft, [day]: [] }, done: { ...prev.done, [day]: [] } }));
    postJson("/api/route/draft", { day, entries: [] })
      .then(() => postJson("/api/route/done", { day, done: [] }))
      .catch(() => {});
  }

  async function optimize() {
    const driven = stops.filter((s) => !movedIds.has(s.id));
    if (driven.length < 3) return;
    setBusy(true);
    try {
      const points = [...(start ? [start] : []), ...driven, ...(end ? [end] : [])];
      const matrix = await costMatrix(points);
      const order = optimizedStopOrder(matrix, driven.length, start !== null, end !== null);
      // Stops moved to SDR keep their crossed-off rows, at the end.
      const ids = [...order.map((i) => driven[i].id), ...stops.filter((s) => movedIds.has(s.id)).map((s) => s.id)];
      // A calendar stop keeps its time: the rest are ordered, then it goes
      // back in where its time falls.
      const byId = new Map(draft.map((e) => [typeof e === "string" ? e : e.id, e]));
      const timed = draft.filter((e): e is CustomStop => typeof e !== "string" && !!e.calendarId);
      if (timed.length === 0) {
        reorder(ids);
        return;
      }
      const rest = ids.map((id) => byId.get(id)!).filter((e) => e && (typeof e === "string" || !e.calendarId));
      const placed = placeByTime(
        rest,
        timed.map((e) => ({ entry: e, at: minutesOfDay(stopTimes[e.id] ?? "00:00") })),
        pointOfEntry,
        start,
        minutesOfDay(stopTimes[DEPART_KEY] ?? data.prefs.depart),
        prefs.dwellMinutes,
        timeOfEntry,
      );
      patchDraft(activeDay, placed);
    } finally {
      setBusy(false);
    }
  }

  const driveMinutes = shownLegs ? shownLegs.reduce((s, l) => s + l.minutes, 0) : null;
  const driveMiles = shownLegs ? shownLegs.reduce((s, l) => s + l.miles, 0) : null;

  function legBetween(i: number): DriveLeg | null {
    if (!shownLegs || i < 1) return null;
    return shownLegs.slice(routeStart ? 1 : 0, shownLegs.length - (end ? 1 : 0))[i - 1] ?? null;
  }

  return (
    <div className="flex flex-col gap-3">
      {accountPanel.panel}
      <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto pb-1">
        {days.map((d) => {
          const { weekday, short } = dayLabel(d);
          return (
            <button key={d} type="button" onClick={() => setActiveDay(d)} className={dayBtn(d === activeDay)}>
              {weekday} <span className="tabular-nums opacity-80">{short}</span>
            </button>
          );
        })}
      </div>

      <DayBar
        prefs={prefs}
        onChange={patchPrefs}
        start={start}
        end={end}
        home={data.home}
        myLoc={myLoc}
        onChangeStart={(ep) => patchEndpoint(activeDay, "start", ep)}
        onChangeEnd={(ep) => patchEndpoint(activeDay, "end", ep)}
        finish={schedule?.finish ?? null}
        driveMinutes={driveMinutes}
        driveMiles={driveMiles}
        state={legState}
        hasStops={stops.length > 0}
      />

      <div ref={mapBoxRef}>
        <AccountsMap
          accounts={data.accounts}
          days={days}
          activeDay={activeDay}
          draftByDay={data.draft}
          stops={stops.filter((s) => !movedIds.has(s.id))}
          start={routeStart}
          end={end}
          coords={coords}
          doneIds={doneIds}
          focus={focus}
          onAddToRouteOnDay={onAddToRouteOnDay}
        />
      </div>

      {calls.length > 0 && (
        <ul className="divide-y divide-[#EEECE3] overflow-hidden rounded-lg border border-[#E2DFD5] bg-white">
          {calls.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-4 py-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#2C6A46] text-white">
                <Ico name="clock" size={13} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[14px] font-medium">{c.label}</span>
                  <a href={`tel:${c.phone}`} className="text-[13px] font-medium tabular-nums text-[#3D4A44]">
                    {c.phone}
                  </a>
                </div>
                {c.note && <p className="mt-0.5 text-[12.5px] text-[#5B6560]">{c.note}</p>}
              </div>
              <button
                type="button"
                onClick={() => patchCalls(activeDay, calls.filter((x) => x.id !== c.id))}
                aria-label={`Remove ${c.label}`}
                className="min-h-11 min-w-11 rounded-md text-[#A9AFA9] transition-colors hover:bg-[#FAF9F5] hover:text-[#B5372A]"
              >
                <Ico name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <AddStop
        accounts={data.accounts}
        inRoute={inRoute}
        activeDay={activeDay}
        onAddAccount={(a) => addEntry(a.id, a.lat, a.lng)}
        onAddPlaceAccount={(a) => {
          setData((prev) => (prev.accounts.some((x) => x.id === a.id) ? prev : { ...prev, accounts: [...prev.accounts, a] }));
          void addEntry(a.id, a.lat, a.lng);
        }}
        onAddCustomStop={(stop) => {
          const id = `custom:${newKey()}`;
          addEntry({ ...stop, id }, stop.lat, stop.lng);
        }}
      />

      {stops.length > 0 && (
        <div className="flex items-center gap-2">
          <button type="button" onClick={optimize} disabled={busy || stops.length < 3} className={iconBtn}>
            <Ico name="gauge" size={14} />
            {busy ? "Working it out" : "Optimize route"}
          </button>
        </div>
      )}

      {stops.length === 0 ? (
        <p className="text-[13.5px] text-[#8A928C]">Nothing on this day yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[#E2DFD5] bg-white">
          {routeStart && (
            <div className="flex items-center justify-between border-b border-[#EEECE3] bg-[#FAF9F5] px-4 py-2 text-[12.5px] text-[#5B6560]">
              <span>
                Leave {routeStart.label} <span className="font-medium tabular-nums text-[#3D4A44]">{prefs.depart}</span>
              </span>
              {schedule?.toFirst && (
                <span className="tabular-nums text-[#8A928C]">
                  {duration(schedule.toFirst.minutes)} · {schedule.toFirst.miles.toFixed(1)} mi
                </span>
              )}
            </div>
          )}
          <ul ref={listRef} className="divide-y divide-[#EEECE3]">
            {stops.map((s, i) => {
              const a = s.type === "account" ? s.account : null;
              const c = s.type === "custom" ? s.custom : null;
              const title = a ? a.name : c!.pending ? (c!.area ? (areaLabels.get(c!.area) ?? c!.area) : "Lunch") : c!.label;
              const isDone = doneIds.has(s.id);
              // A done stop on a live day is behind the rep: no ETA, no drive.
              const ri = routedIndex.get(s.id);
              const leg = ri === undefined ? null : legBetween(ri);
              const prev = ri !== undefined && ri > 0 ? routed[ri - 1] : null;
              const email = isDone && data.logged?.[activeDay]?.includes(s.id) ? data.emails?.[s.id] : undefined;
              const hours = a ? hoursStatusNow(a.business_hours) : null;
              const closed = schedule?.closedToday.has(s.id);
              const missedAnchor = schedule?.missedAnchors.has(s.id);
              const dropBefore = drag && drag.dropIndex === i && drag.id !== s.id;
              const dropAtEnd = drag && drag.dropIndex === stops.length && i === stops.length - 1;
              const lockedAt = /^\d{1,2}:\d{2}$/.test(stopTimes[s.id] ?? "") ? stopTimes[s.id] : null;
              if (movedIds.has(s.id)) {
                return (
                  <li key={s.id} data-stop-id={s.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#ECEAE1] text-[#8A928C]">
                      <Ico name="phone" size={13} />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="truncate text-[14.5px] font-medium text-[#8A928C] line-through">{title}</span>
                      <span className="rounded bg-[#E4EFE8] px-1.5 py-0.5 text-[10.5px] font-medium text-[#2C6A46]">Moved to SDR</span>
                    </div>
                    <button type="button" onClick={() => keepOnRoute(s.id)} className={iconBtn}>
                      Keep on route
                    </button>
                  </li>
                );
              }
              return (
                <li
                  key={s.id}
                  data-stop-id={s.id}
                  className={`flex flex-col gap-2 px-4 py-3 ${drag?.id === s.id ? "opacity-40" : ""} ${
                    dropBefore ? "border-t-2 border-[#2C6A46]" : ""
                  } ${dropAtEnd ? "border-b-2 border-[#2C6A46]" : ""}`}
                >
                  <div className="flex items-start gap-3">
                    {isDone ? (
                      // Done shows once, here: the check and the struck name.
                      // Tapping the check puts the stop back on the day.
                      <button
                        type="button"
                        onClick={() => toggleDone(s.id)}
                        aria-label={`Mark ${title} not done`}
                        className="-mx-2 -mb-2 -mt-1.5 flex h-11 w-11 shrink-0 items-center justify-center transition-transform active:scale-[0.95]"
                      >
                        <span
                          className={`flex h-7 w-7 items-center justify-center text-white ${
                            c ? "rounded-[4px] bg-[#A0762C]" : "rounded-full bg-[#14201B]"
                          }`}
                        >
                          <Ico name="check" size={13} />
                        </span>
                      </button>
                    ) : (
                      <span
                        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center text-[12px] font-semibold tabular-nums text-white ${
                          c ? "rounded-[4px] bg-[#A0762C]" : "rounded-full bg-[#14201B]"
                        }`}
                      >
                        {stopNumber.get(s.id) ?? i + 1}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        {a ? (
                          <Link
                            prefetch={false}
                            href={`/account/${a.id}`}
                            onClick={(e) => accountPanel.open(e, a)}
                            className={`truncate text-[14.5px] font-medium underline-offset-2 hover:underline ${isDone ? "line-through text-[#8A928C]" : ""}`}
                          >
                            {title}
                          </Link>
                        ) : (
                          <span className={`truncate text-[14.5px] font-medium ${isDone ? "line-through text-[#8A928C]" : ""}`}>{title}</span>
                        )}
                        {c && (
                          <span className="rounded bg-[#F6EEDD] px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-[#7A5A1E]">
                            {CUSTOM_STOP_LABEL[c.kind]}
                          </span>
                        )}
                        {schedule && ri !== undefined && schedule.rows[ri] && (!lockedAt || missedAnchor) && (
                          <span className="text-[17px] font-bold tabular-nums text-[#14201B]">{clock(schedule.rows[ri].arrive)}</span>
                        )}
                        {closed && (
                          <span className="rounded bg-[#F6E4DF] px-1.5 py-0.5 text-[10.5px] font-medium text-[#8A3B2E]">closed the rest of the day</span>
                        )}
                        {c?.kind !== "event" && schedule && ri !== undefined && (schedule.rows[ri]?.leave ?? 0) > FINISH_BY_MINUTES && (
                          <span className="rounded bg-[#F6E4DF] px-1.5 py-0.5 text-[10.5px] font-medium text-[#8A3B2E]">past 3 PM</span>
                        )}
                        {missedAnchor && (
                          <span className="rounded bg-[#F6E4DF] px-1.5 py-0.5 text-[10.5px] font-medium text-[#8A3B2E]">later than stated time</span>
                        )}
                        {hours && (
                          <span className={`text-[12px] font-medium ${hours.open ? "text-[#2C6A46]" : "text-[#8A928C]"}`}>{hours.label}</span>
                        )}
                      </div>
                      {!c?.pending && (
                        <div className="mt-0.5 truncate text-[13px] text-[#5B6560]">{a ? `${a.street ?? ""}${a.city ? `, ${a.city}` : ""}` : c!.address}</div>
                      )}
                      {c && c.kind === "lunch" && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                          <LunchPlace
                            near={{ lat: s.lat, lng: s.lng }}
                            picked={!c.pending}
                            onPick={(p) => patchCustom(c.id, { label: p.label, address: p.address, lat: p.lat, lng: p.lng, phone: p.phone, pending: undefined })}
                          />
                          {c.phone && (
                            <a href={`tel:${c.phone}`} className="inline-flex min-h-8 items-center gap-1 font-medium tabular-nums text-[#3D4A44] hover:underline">
                              <Ico name="phone" size={12} />
                              {prettyPhone(c.phone)}
                            </a>
                          )}
                        </div>
                      )}
                      {a && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] text-[#5B6560]">
                          {a.last_order_at ? (
                            <span>
                              last order <span className="font-medium text-[#3D4A44]">{monthYear(a.last_order_at)}</span>
                            </span>
                          ) : (
                            <span className="text-[#A9AFA9]">never ordered</span>
                          )}
                          {lastTouchLabel(lastTouchById[a.id]) && (
                            <span className="rounded-full bg-[#ECEAE1] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-[#3D4A44]">
                              {lastTouchLabel(lastTouchById[a.id])}
                            </span>
                          )}
                          {a.trailing_12m_revenue !== null && (
                            <span>
                              12m <span className="font-medium tabular-nums text-[#3D4A44]">{usd(a.trailing_12m_revenue)}</span>
                            </span>
                          )}
                          {a.lifetime_revenue !== null && (
                            <span>
                              lifetime <span className="font-medium tabular-nums text-[#3D4A44]">{usd(a.lifetime_revenue)}</span>
                            </span>
                          )}
                        </div>
                      )}
                      {a && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
                          {a.hubspot_company_id ? (
                            <a
                              href={HUBSPOT_COMPANY_URL(a.hubspot_company_id)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex min-h-8 items-center gap-1 font-medium text-[#3D4A44] hover:underline"
                            >
                              <Ico name="hubspot" size={12} />
                              HubSpot
                            </a>
                          ) : (
                            <span className="text-[#A9AFA9]">not in HubSpot</span>
                          )}
                          {a.website ? (
                            <a
                              href={absoluteUrl(a.website)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex min-h-8 min-w-0 items-center gap-1 font-medium text-[#3D4A44] hover:underline"
                            >
                              <Ico name="globe" size={12} />
                              <span className="max-w-[22ch] truncate">{prettyUrl(a.website)}</span>
                            </a>
                          ) : (
                            <span className="text-[#A9AFA9]">no site on file</span>
                          )}
                          {a.phone ? (
                            <a
                              href={`tel:${a.phone}`}
                              className="inline-flex min-h-8 items-center gap-1 font-medium tabular-nums text-[#3D4A44] hover:underline"
                            >
                              <Ico name="phone" size={12} />
                              {prettyPhone(a.phone)}
                            </a>
                          ) : (
                            <span className="text-[#A9AFA9]">no phone on file</span>
                          )}
                        </div>
                      )}
                      {c && !lockedAt && (c.kind === "hotel" || c.kind === "lunch") && (
                        <label className="mt-1 flex items-center gap-1.5 text-[12.5px] text-[#5B6560]">
                          At
                          <input
                            type="time"
                            defaultValue=""
                            onBlur={(e) => e.target.value && setLockedTime(s.id, e.target.value)}
                            className={inputCls}
                            style={{ width: "8rem" }}
                          />
                        </label>
                      )}
                      {prev &&
                        !c?.pending &&
                        (leg ? (
                          <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[#8A928C]">
                            <span
                              aria-hidden
                              className="inline-block h-2 w-2 shrink-0 rounded-full ring-1 ring-[#14201B]/40"
                              style={{ backgroundColor: BAND_STYLE[driveBand(leg.minutes)].color }}
                            />
                            <span className="text-[16px] font-bold tabular-nums text-[#14201B]">{duration(leg.minutes)}</span>
                            <span>
                              drive · <span className="tabular-nums">{leg.miles.toFixed(1)} mi</span>
                            </span>
                          </div>
                        ) : (
                          <div className="mt-0.5 text-[12px] text-[#8A928C]">
                            <span className="tabular-nums">{haversineMiles(prev, s).toFixed(1)} mi</span> straight-line
                          </div>
                        ))}
                    </div>
                    {lockedAt && (
                      <LockedTime
                        value={lockedAt}
                        label={title}
                        clearable={!c?.calendarId}
                        onSave={(v) => setLockedTime(s.id, v)}
                      />
                    )}
                  </div>
                  {confirmingDone.has(s.id) ? (
                    <div className="max-w-xs">
                      <SuccessNote title="Marked done" onUndo={() => undoMarkDone(s.id)} />
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onPointerDown={(e) => handleGripDown(e, s.id, i)}
                        onPointerMove={handleGripMove}
                        onPointerUp={handleGripUp}
                        onPointerCancel={() => setDrag(null)}
                        aria-label={`Drag ${title} to reorder`}
                        style={{ touchAction: "none" }}
                        className={`${sqBtn} cursor-grab active:cursor-grabbing`}
                      >
                        <RowIco name="grip" />
                      </button>
                      {!isDone && (
                        <button type="button" onClick={() => toggleDone(s.id)} className={iconBtn}>
                          <Ico name="check" size={13} />
                          Mark done
                        </button>
                      )}
                      {email && <OpenEmailButtons draft={email} label="Open email" copy={false} />}
                      {days.length > 1 && (
                        <DayMoveMenu
                          days={days}
                          active={activeDay}
                          onPick={(day) => moveStopToDay(s.id, day)}
                          label={`Move ${title} to a day`}
                          className={sqBtn}
                        />
                      )}
                      {a && (
                        <Link
                          href={{ pathname: "/visit", query: { account: a.id, name: a.name } }}
                          className={iconBtn}
                        >
                          <Ico name="plus" size={13} />
                          Log a visit
                        </Link>
                      )}
                      {!c?.pending && (
                        <a
                          href={appleMapsUrl({ address: c ? c.address : a ? fullAddress(a) : null, lat: s.lat, lng: s.lng })}
                          className="inline-flex min-h-11 items-center rounded-md bg-[#2C6A46] px-4 text-[13px] font-semibold text-white transition-transform active:scale-[0.97]"
                        >
                          GO
                        </a>
                      )}
                      <button
                        type="button"
                        onClick={() => removeStop(s.id)}
                        aria-label={`Remove ${title} from the route`}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center glass rounded-xl text-[#8A928C] transition-colors hover:text-[#B5372A]"
                      >
                        <Ico name="close" size={14} />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {end && (
            <div className="flex flex-col gap-2 border-t border-[#EEECE3] px-4 py-3">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] bg-[#14201B] text-white">
                  <Ico name="pin" size={13} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[14.5px] font-medium">
                    <EndpointField label="End" value={end} fallback={null} home={data.home} myLoc={myLoc} onChange={(ep) => patchEndpoint(activeDay, "end", ep)} up />
                    <span className="rounded bg-[#F6EEDD] px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-[#7A5A1E]">End</span>
                    {schedule?.end && (
                      <span className="text-[17px] font-bold tabular-nums text-[#14201B]">{clock(schedule.finish)}</span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[13px] text-[#5B6560]">{end.address}</div>
                  {schedule?.end && (
                    <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-[#8A928C]">
                      <span
                        aria-hidden
                        className="inline-block h-2 w-2 shrink-0 rounded-full ring-1 ring-[#14201B]/40"
                        style={{ backgroundColor: BAND_STYLE[driveBand(schedule.end.minutes)].color }}
                      />
                      <span className="text-[16px] font-bold tabular-nums text-[#14201B]">{duration(schedule.end.minutes)}</span>
                      <span>
                        drive · <span className="tabular-nums">{schedule.end.miles.toFixed(1)} mi</span>
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <a
                  href={appleMapsUrl({ address: end.address, lat: end.lat, lng: end.lng })}
                  className="inline-flex min-h-11 items-center rounded-md bg-[#2C6A46] px-4 text-[13px] font-semibold text-white transition-transform active:scale-[0.97]"
                >
                  GO
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      {stops.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {stops.length > 1 && (
            <a href={appleMapsRouteUrl(stops)} className={iconBtn}>
              <Ico name="pin" size={13} />
              Open all in Maps
            </a>
          )}
          <button
            type="button"
            onClick={clearDay}
            className="inline-flex min-h-11 items-center glass rounded-xl px-3 text-[13px] font-medium text-[#8A928C] transition-colors hover:text-[#B5372A]"
          >
            Clear route
          </button>
        </div>
      )}

      <ReturnSuggestions
        activeDay={activeDay}
        accountsById={accountsById}
        inRoute={inRoute}
        onAddToDay={(a) => addEntry(a.id, a.lat, a.lng)}
      />
    </div>
  );
}

/** A locked stop's time, top right of its card. The time field sits over
 *  the clock, so a tap opens the phone's time picker; closing it saves,
 *  Escape keeps the old time. */
function LockedTime({
  value,
  label,
  clearable,
  onSave,
}: {
  value: string;
  label: string;
  clearable: boolean;
  onSave: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [from, setFrom] = useState(value);
  if (from !== value) {
    setFrom(value);
    setDraft(value);
  }
  const shown = draft || value;
  return (
    <label className="relative -mr-1 -mt-1 inline-flex min-h-11 shrink-0 cursor-pointer items-center rounded-md px-2 transition-transform active:scale-[0.97] motion-reduce:transition-none">
      <span
        aria-hidden
        className="text-[17px] font-bold tabular-nums text-[#14201B] underline decoration-[#C9C5B8] decoration-dotted underline-offset-4"
      >
        {clock(minutesOfDay(shown))}
      </span>
      <input
        type="time"
        value={draft}
        aria-label={`Time for ${label}`}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => {
          try {
            e.currentTarget.showPicker?.();
          } catch {
            // the field still takes typed input where the picker will not open
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") {
            setDraft(value);
            e.currentTarget.blur();
          }
        }}
        onBlur={() => {
          if (draft === value) return;
          if (draft) onSave(draft);
          else if (clearable) onSave(null);
          else setDraft(value);
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </label>
  );
}

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// Through the native plugin, like every other location read: in the app it
// rides the app's own location permission, so the web view never asks again.
function locateMe(): Promise<RouteEndpoint | null> {
  return Geolocation.getCurrentPosition({ enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 })
    .then((p) => ({ label: "My location", address: "Current location", lat: p.coords.latitude, lng: p.coords.longitude }))
    .catch(() => null);
}

function EndpointField({
  label,
  value,
  fallback,
  home,
  myLoc,
  onChange,
  up,
}: {
  label: string;
  value: RouteEndpoint | null;
  fallback: RouteEndpoint | null;
  home: RouteEndpoint | null;
  myLoc: RouteEndpoint | null;
  onChange: (ep: RouteEndpoint | null) => void;
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RouteEndpoint[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const current = value ?? fallback;

  function runSearch(q: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 3) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiFetch("/api/route/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q, mode: "search" }),
        });
        const j = await res.json();
        setResults(j.ok ? j.results : []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border-b border-dashed border-[#A9AFA9] font-medium text-[#3D4A44]"
      >
        {current?.label ?? label}
      </button>
    );
  }

  return (
    <span className="relative inline-block align-middle">
      <input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          runSearch(e.target.value);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={label}
        className="min-h-11 w-40 glass rounded-xl px-2.5 py-1 text-base outline-none"
      />
      {(home || myLoc || results.length > 0 || searching) && (
        <div className={`absolute left-0 z-20 max-h-56 ${up ? "bottom-full mb-1" : "top-full mt-1"} w-56 overflow-auto rounded-md border border-[#E2DFD5] bg-white py-1 shadow-lg`}>
          <button
            type="button"
            onMouseDown={async () => {
              const here = myLoc ?? (await locateMe());
              if (here) onChange(here);
              setOpen(false);
              setQuery("");
            }}
            className="flex min-h-11 w-full flex-col items-start justify-center px-3 py-1.5 text-left text-[13px] hover:bg-[#FAF9F5]"
          >
            <span className="font-medium">My location</span>
          </button>
          {home && (
            <button
              type="button"
              onMouseDown={() => {
                onChange(home);
                setOpen(false);
                setQuery("");
              }}
              className="flex min-h-11 w-full flex-col items-start justify-center px-3 py-1.5 text-left text-[13px] hover:bg-[#FAF9F5]"
            >
              <span className="font-medium">{home.label}</span>
              <span className="truncate text-[11.5px] text-[#8A928C]">{home.address}</span>
            </button>
          )}
          {searching && <div className="px-3 py-1.5 text-[12px] text-[#8A928C]">Searching</div>}
          {results.map((r, i) => (
            <button
              key={`${r.lat},${r.lng},${i}`}
              type="button"
              onMouseDown={() => {
                onChange(r);
                setOpen(false);
                setQuery("");
              }}
              className="flex min-h-11 w-full flex-col items-start justify-center px-3 py-1.5 text-left text-[13px] hover:bg-[#FAF9F5]"
            >
              <span className="truncate font-medium">{r.label}</span>
              <span className="truncate text-[11.5px] text-[#8A928C]">{r.address}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** The lunch spot, picked by its Google Maps name near where the day has
 *  lunch. Picking one moves the stop there and brings its phone number. */
type LunchPick = { label: string; address: string; lat: number; lng: number; phone: string | null };
function LunchPlace({ near, picked, onPick }: { near: { lat: number; lng: number }; picked: boolean; onPick: (p: LunchPick) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LunchPick[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function runSearch(q: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 3) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiFetch("/api/route/lookup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: q, mode: "search", near }),
        });
        const j = await res.json();
        setResults(j.ok ? j.results : []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 250);
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={iconBtn}>
        <Ico name="search" size={13} />
        {picked ? "Change place" : "Pick a place"}
      </button>
    );
  }

  return (
    <span className="relative inline-block">
      <input
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          runSearch(e.target.value);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Restaurant name"
        className="min-h-11 w-60 glass rounded-xl px-2.5 py-1 text-base outline-none"
      />
      {(results.length > 0 || searching) && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-64 w-72 overflow-auto rounded-md border border-[#E2DFD5] bg-white py-1 shadow-lg">
          {searching && <div className="px-3 py-1.5 text-[12px] text-[#8A928C]">Searching</div>}
          {results.map((r, i) => (
            <button
              key={`${r.lat},${r.lng},${i}`}
              type="button"
              onMouseDown={() => {
                onPick(r);
                setOpen(false);
                setQuery("");
              }}
              className="flex min-h-11 w-full flex-col items-start justify-center px-3 py-1.5 text-left text-[13px] hover:bg-[#FAF9F5]"
            >
              <span className="truncate font-medium">{r.label}</span>
              <span className="truncate text-[11.5px] text-[#8A928C]">{r.address}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function DayBar({
  prefs,
  onChange,
  start,
  end,
  home,
  myLoc,
  onChangeStart,
  onChangeEnd,
  finish,
  driveMinutes,
  driveMiles,
  state,
  hasStops,
}: {
  prefs: RouteSchedulePrefs;
  onChange: (p: RouteSchedulePrefs) => void;
  start: RouteEndpoint | null;
  end: RouteEndpoint | null;
  home: RouteEndpoint | null;
  myLoc: RouteEndpoint | null;
  onChangeStart: (ep: RouteEndpoint | null) => void;
  onChangeEnd: (ep: RouteEndpoint | null) => void;
  finish: number | null;
  driveMinutes: number | null;
  driveMiles: number | null;
  state: "loading" | "ok" | "unavailable";
  hasStops: boolean;
}) {
  return (
    <div className="rounded-lg border border-[#E2DFD5] bg-white p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-[#5B6560]">
        <span className="flex items-center gap-1.5">
          Leave <EndpointField label="Start" value={start} fallback={home} home={home} myLoc={myLoc} onChange={onChangeStart} />
          at
          <input type="time" value={prefs.depart} onChange={(e) => onChange({ ...prefs, depart: e.target.value })} className={`${inputCls} w-auto tabular-nums font-medium`} />
        </span>
        <label className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={240}
            value={prefs.dwellMinutes}
            onChange={(e) => onChange({ ...prefs, dwellMinutes: Number(e.target.value) })}
            className={`${inputCls} w-[4.5rem] text-center tabular-nums font-medium`}
          />
          min per stop
        </label>
        <label className="flex items-center gap-1.5">
          <input
            type="number"
            min={0}
            max={240}
            value={prefs.lunchMinutes}
            onChange={(e) => onChange({ ...prefs, lunchMinutes: Number(e.target.value) })}
            className={`${inputCls} w-[4.5rem] text-center tabular-nums font-medium`}
          />
          min lunch
        </label>
        <span className="flex items-center gap-1.5">
          Arrive <EndpointField label="End" value={end} fallback={home} home={home} myLoc={myLoc} onChange={onChangeEnd} />
        </span>
      </div>

      {hasStops && (
        <div className="mt-2.5 border-t border-[#EEECE3] pt-2.5 text-[13px]">
          {state === "loading" && <span className="text-[#8A928C]">Working out drive times</span>}
          {state === "unavailable" && <span className="text-[#8A928C]">Drive times unavailable</span>}
          {state === "ok" && finish !== null && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold text-[#2C6A46]">
                Back {end?.label !== "Home" && end?.label ? `at ${end.label} ` : ""}
                <span className="tabular-nums">{clock(finish)}</span>
              </span>
              {driveMinutes !== null && (
                <span className="text-[#5B6560]">
                  <span className="tabular-nums">{duration(driveMinutes)}</span> driving
                  {driveMiles !== null && (
                    <>
                      {" · "}
                      <span className="tabular-nums">{driveMiles.toFixed(1)} mi</span>
                    </>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
