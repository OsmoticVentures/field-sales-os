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
 * at a red light); RouteMap.tsx above it shows the shape of the day on a
 * vanilla google.maps canvas, no map dependency added.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { apiFetch } from "@/lib/core/api";
import { Ico, SuccessNote, ghostBtn, inputCls } from "@/lib/core/ui";
import { RouteMap } from "./RouteMap";
import { dayLabel, defaultActiveDay, planningHorizonDates } from "@/lib/features/route/field-week";
import { pushToOpenWindow, hoursStatusNow } from "@/lib/features/route/hours";
import { cheapestGap, haversineMatrix, haversineMiles, optimizedStopOrder, type Matrix } from "@/lib/features/route/route-optimize";
import { BAND_STYLE, driveBand, likelyDriveMinutes } from "@/lib/features/route/traffic";
import { CUSTOM_STOP_LABEL } from "@/lib/features/route/types";
import type {
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
import { DayMoveMenu, RowIco } from "./RowControls";
import { HUBSPOT_COMPANY_URL } from "@/lib/features/prospect/format";

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
};

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": newKey() },
    body: JSON.stringify(body),
  });
  return res.json();
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
};

/** Priced forward, one pass: a leg's cost depends on when it departs, and
 *  that depends on every leg before it. Anchors (a stated time) and business
 *  hours (a hard constraint) both only ever push the clock FORWARD, never
 *  rewind it, and a stop that cannot be reached open is named rather than
 *  scheduled anyway. */
function buildSchedule(
  stops: RouteStopView[],
  legs: DriveLeg[],
  hasStart: boolean,
  hasEnd: boolean,
  prefs: RouteSchedulePrefs,
  dayISO: string,
  anchors: Record<string, string>,
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

  stops.forEach((s, i) => {
    if (i > 0) {
      const hop = price(between[i - 1], t);
      if (hop) priced[betweenOffset + i - 1] = hop;
      t += hop?.minutes ?? 0;
    }
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
    const stay = kind === "lunch" ? prefs.lunchMinutes : kind === "hotel" ? 0 : prefs.dwellMinutes;
    rows.push({ arrive: t, leave: t + stay, stay });
    t += stay;
  });

  const endLeg = hasEnd ? price(legs[legs.length - 1], t) : null;
  if (hasEnd && endLeg) priced[legs.length - 1] = endLeg;
  for (let i = 0; i < legs.length; i++) if (!priced[i]) priced[i] = legs[i];

  return { rows, finish: t + (endLeg?.minutes ?? 0), toFirst, end: endLeg, priced, missedAnchors, closedToday };
}

const dayBtn = (active: boolean) =>
  `min-h-11 shrink-0 rounded-md px-3.5 py-2 text-[13px] font-medium transition-transform active:scale-[0.97] ${
    active ? "bg-[#14201B] text-[#F7F6F1]" : "border border-[#E2DFD5] bg-white text-[#5B6560]"
  }`;
/** ghostBtn plus the icon+label layout most row actions need; composed, not
 *  a fork, so the base still comes from lib/core/ui. */
const iconBtn = `${ghostBtn} inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[13px] font-medium text-[#3D4A44]`;
/** Square 44px icon-only row control. */
const sqBtn = `${ghostBtn} inline-flex min-w-11 items-center justify-center bg-white px-0 py-0`;

export function RouteClient() {
  const [data, setData] = useState<StatePayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeDay, setActiveDay] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/route/state")
      .then((r) => r.json())
      .then((j: StatePayload) => {
        if (!j.ok) {
          setLoadError("Couldn't load the route.");
          return;
        }
        setData(j);
        setActiveDay(j.activeDay);
      })
      .catch(() => setLoadError("Couldn't load the route."));
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
  return <RouteDay data={data} setData={setDataForDay} activeDay={activeDay} setActiveDay={setActiveDay} />;
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
  const accountsById = useMemo(() => new Map(data.accounts.map((a) => [a.id, a])), [data.accounts]);

  const draft = data.draft[activeDay] ?? [];
  const calls = data.calls[activeDay] ?? [];
  const doneIds = useMemo(() => new Set(data.done[activeDay] ?? []), [data.done, activeDay]);
  const stopTimes = data.times[activeDay] ?? {};

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
  const startFallback = (prevDay ? data.endByDay[prevDay] : null) ?? data.home;
  const start = data.startByDay[activeDay] ?? startFallback;
  const end = data.endByDay[activeDay] ?? data.home;

  const [prefs, setPrefsLocal] = useState<RouteSchedulePrefs>(data.prefs);
  useEffect(() => setPrefsLocal(data.prefs), [data.prefs]);

  const [busy, setBusy] = useState(false);
  const [legs, setLegs] = useState<DriveLeg[] | null>(null);
  const [coords, setCoords] = useState<[number, number][] | null>(null);
  const [legState, setLegState] = useState<"loading" | "ok" | "unavailable">("loading");
  const [confirmingDone, setConfirmingDone] = useState<Set<string>>(new Set());
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
        start ? `s:${start.lat},${start.lng}` : "s:-",
        ...stops.map((s) => `${s.lat},${s.lng}`),
        end ? `e:${end.lat},${end.lng}` : "e:-",
      ].join("|"),
    [stops, start, end],
  );

  useEffect(() => {
    const points = [...(start ? [start] : []), ...stops, ...(end ? [end] : [])];
    if (points.length < 2) {
      setLegs(null);
      setCoords(null);
      setLegState("ok");
      return;
    }
    let live = true;
    setLegState("loading");
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
    () => (legs ? buildSchedule(stops, legs, start !== null, end !== null, prefs, activeDay, stopTimes) : null),
    [legs, stops, start, end, prefs, activeDay, stopTimes],
  );
  const shownLegs = schedule?.priced ?? legs;

  // Only a hard conflict makes a stop not fit: the door is shut for the rest
  // of the day, or the drive misses a stated time.
  const wontFit = useMemo(() => {
    if (!schedule) return [];
    return stops
      .filter((s) => schedule.closedToday.has(s.id) || schedule.missedAnchors.has(s.id))
      .map((s) => {
        const anchor = stopTimes[s.id];
        const reason = schedule.closedToday.has(s.id)
          ? "closed the rest of the day"
          : `arrives after its ${clock(minutesOfDay(anchor))} time`;
        return { id: s.id, name: s.type === "account" ? s.account.name : s.custom.label, reason };
      });
  }, [schedule, stops, stopTimes]);

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

  function patchDraft(day: string, entries: RouteDraftEntry[]) {
    setData({ ...data, draft: { ...data.draft, [day]: entries } });
    postJson("/api/route/draft", { day, entries }).catch(() => {});
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
    setPrefsLocal(next);
    postJson<{ ok: boolean }>("/api/route/prefs", next).catch(() => {});
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

  function removeStop(id: string) {
    patchDraft(
      activeDay,
      draft.filter((e) => (typeof e === "string" ? e !== id : e.id !== id)),
    );
  }
  function moveStop(id: string, dir: -1 | 1) {
    const ids = stops.map((s) => s.id);
    const from = ids.indexOf(id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= ids.length) return;
    const order = [...ids];
    [order[from], order[to]] = [order[to], order[from]];
    reorder(order);
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
    setTimeout(() => {
      setConfirmingDone((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setData((prev) => {
        const nextDone = Array.from(new Set([...(prev.done[day] ?? []), id]));
        postJson("/api/route/done", { day, done: nextDone }).catch(() => {});
        return { ...prev, done: { ...prev.done, [day]: nextDone } };
      });
    }, 1000);
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
  function moveToTop(id: string) {
    const ids = stops.map((s) => s.id);
    if (ids.indexOf(id) <= 0) return;
    reorder([id, ...ids.filter((x) => x !== id)]);
  }
  function showInMap(id: string) {
    setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
    mapBoxRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function clearDay() {
    const day = activeDay;
    setData((prev) => ({ ...prev, draft: { ...prev.draft, [day]: [] }, done: { ...prev.done, [day]: [] } }));
    postJson("/api/route/draft", { day, entries: [] })
      .then(() => postJson("/api/route/done", { day, done: [] }))
      .catch(() => {});
  }

  async function optimize() {
    if (stops.length < 3) return;
    setBusy(true);
    try {
      const points = [...(start ? [start] : []), ...stops, ...(end ? [end] : [])];
      const matrix = await costMatrix(points);
      const order = optimizedStopOrder(matrix, stops.length, start !== null, end !== null);
      reorder(order.map((i) => stops[i].id));
    } finally {
      setBusy(false);
    }
  }

  const driveMinutes = shownLegs ? shownLegs.reduce((s, l) => s + l.minutes, 0) : null;
  const driveMiles = shownLegs ? shownLegs.reduce((s, l) => s + l.miles, 0) : null;

  function legBetween(i: number): DriveLeg | null {
    if (!shownLegs || i < 1) return null;
    return shownLegs.slice(start ? 1 : 0, shownLegs.length - (end ? 1 : 0))[i - 1] ?? null;
  }

  return (
    <div className="flex flex-col gap-3">
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

      {wontFit.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-[#E2DFD5] bg-[#FAF9F5] px-3.5 py-3 text-[13px] leading-relaxed text-[#3D4A44]">
          {wontFit.map((w) => (
            <li key={w.id}>
              <span className="font-medium">{w.name}</span> won't fit, {w.reason}
            </li>
          ))}
        </ul>
      )}

      <DayBar
        prefs={prefs}
        onChange={patchPrefs}
        start={start}
        end={end}
        home={data.home}
        onChangeStart={(ep) => patchEndpoint(activeDay, "start", ep)}
        onChangeEnd={(ep) => patchEndpoint(activeDay, "end", ep)}
        finish={schedule?.finish ?? null}
        driveMinutes={driveMinutes}
        driveMiles={driveMiles}
        state={legState}
        hasStops={stops.length > 0}
      />

      {(stops.length > 0 || start) && (
        <div ref={mapBoxRef}>
          <RouteMap stops={stops} start={start} end={end} coords={coords} doneIds={doneIds} focus={focus} />
        </div>
      )}

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
          {start && (
            <div className="flex items-center justify-between border-b border-[#EEECE3] bg-[#FAF9F5] px-4 py-2 text-[12.5px] text-[#5B6560]">
              <span>
                Leave {start.label} <span className="font-medium tabular-nums text-[#3D4A44]">{prefs.depart}</span>
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
              const title = a ? a.name : c!.label;
              const isDone = doneIds.has(s.id);
              const leg = legBetween(i);
              const prev = i > 0 ? stops[i - 1] : null;
              const hours = a ? hoursStatusNow(a.business_hours) : null;
              const closed = schedule?.closedToday.has(s.id);
              const missedAnchor = schedule?.missedAnchors.has(s.id);
              const dropBefore = drag && drag.dropIndex === i && drag.id !== s.id;
              const dropAtEnd = drag && drag.dropIndex === stops.length && i === stops.length - 1;
              return (
                <li
                  key={s.id}
                  data-stop-id={s.id}
                  className={`flex flex-col gap-2 px-4 py-3 ${drag?.id === s.id ? "opacity-40" : ""} ${
                    dropBefore ? "border-t-2 border-[#2C6A46]" : ""
                  } ${dropAtEnd ? "border-b-2 border-[#2C6A46]" : ""}`}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center text-[12px] font-semibold tabular-nums text-white ${
                        c ? "rounded-[4px] bg-[#A0762C]" : "rounded-full bg-[#14201B]"
                      }`}
                    >
                      {isDone ? <Ico name="check" size={13} /> : i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className={`truncate text-[14.5px] font-medium ${isDone ? "line-through text-[#8A928C]" : ""}`}>{title}</span>
                        {c && (
                          <span className="rounded bg-[#F6EEDD] px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-[#7A5A1E]">
                            {CUSTOM_STOP_LABEL[c.kind]}
                          </span>
                        )}
                        {schedule && (
                          <span className="text-[17px] font-bold tabular-nums text-[#14201B]">{clock(schedule.rows[i].arrive)}</span>
                        )}
                        {closed && (
                          <span className="rounded bg-[#F6E4DF] px-1.5 py-0.5 text-[10.5px] font-medium text-[#8A3B2E]">closed the rest of the day</span>
                        )}
                        {missedAnchor && (
                          <span className="rounded bg-[#F6E4DF] px-1.5 py-0.5 text-[10.5px] font-medium text-[#8A3B2E]">later than stated time</span>
                        )}
                        {hours && (
                          <span className={`text-[12px] font-medium ${hours.open ? "text-[#2C6A46]" : "text-[#8A928C]"}`}>{hours.label}</span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[13px] text-[#5B6560]">{a ? `${a.street ?? ""}${a.city ? `, ${a.city}` : ""}` : c!.address}</div>
                      {a && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] text-[#5B6560]">
                          {a.last_order_at ? (
                            <span>
                              last order <span className="font-medium text-[#3D4A44]">{monthYear(a.last_order_at)}</span>
                            </span>
                          ) : (
                            <span className="text-[#A9AFA9]">never ordered</span>
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
                      {c && (c.kind === "lunch" || c.kind === "hotel") && (
                        <label className="mt-1 flex items-center gap-1.5 text-[12.5px] text-[#5B6560]">
                          At
                          <input
                            type="time"
                            value={stopTimes[s.id] ?? ""}
                            onChange={(e) => {
                              const next = { ...stopTimes };
                              if (e.target.value) next[s.id] = e.target.value;
                              else delete next[s.id];
                              patchTimes(activeDay, next);
                            }}
                            className={`${inputCls} w-[8rem]`}
                          />
                        </label>
                      )}
                      {prev &&
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
                  </div>
                  {confirmingDone.has(s.id) ? (
                    <div className="max-w-xs">
                      <SuccessNote title="Marked done" />
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
                      <button
                        type="button"
                        onClick={() => toggleDone(s.id)}
                        aria-pressed={isDone}
                        className={
                          isDone
                            ? "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-[#2C6A46] px-3 py-2 text-[13px] font-medium text-white transition-transform active:scale-[0.97] motion-reduce:transition-none"
                            : `${iconBtn} bg-white`
                        }
                      >
                        <Ico name="check" size={13} />
                        {isDone ? "Done" : "Mark done"}
                      </button>
                      <button
                        type="button"
                        onClick={() => moveToTop(s.id)}
                        disabled={i === 0}
                        aria-label={`Move ${title} to the top of the route`}
                        className={sqBtn}
                      >
                        <RowIco name="chevrons-up" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveStop(s.id, -1)}
                        disabled={i === 0}
                        aria-label={`Move ${title} earlier`}
                        className={sqBtn}
                      >
                        <Ico name="chevron-up" size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveStop(s.id, 1)}
                        disabled={i === stops.length - 1}
                        aria-label={`Move ${title} later`}
                        className={sqBtn}
                      >
                        <Ico name="chevron-down" size={14} />
                      </button>
                      {days.length > 1 && (
                        <DayMoveMenu
                          days={days}
                          active={activeDay}
                          onPick={(day) => moveStopToDay(s.id, day)}
                          label={`Move ${title} to a day`}
                          className={sqBtn}
                        />
                      )}
                      <button type="button" onClick={() => showInMap(s.id)} aria-label={`Show ${title} on the map`} className={sqBtn}>
                        <RowIco name="locate" />
                      </button>
                      <a
                        href={appleMapsUrl({ address: c ? c.address : a ? fullAddress(a) : null, lat: s.lat, lng: s.lng })}
                        className="inline-flex min-h-11 items-center rounded-md bg-[#2C6A46] px-4 text-[13px] font-semibold text-white transition-transform active:scale-[0.97]"
                      >
                        GO
                      </a>
                      <button
                        type="button"
                        onClick={() => removeStop(s.id)}
                        aria-label={`Remove ${title} from the route`}
                        className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-[#E2DFD5] bg-white text-[#8A928C] transition-colors hover:border-[#D8B3AC] hover:text-[#B5372A]"
                      >
                        <Ico name="close" size={14} />
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {end && schedule?.end && (
            <div className="flex items-center justify-between border-t border-[#EEECE3] bg-[#FAF9F5] px-4 py-2 text-[12.5px] text-[#5B6560]">
              <span>
                {end.label} <span className="font-medium tabular-nums text-[#3D4A44]">{clock(schedule.finish)}</span>
              </span>
              <span className="tabular-nums text-[#8A928C]">
                {duration(schedule.end.minutes)} · {schedule.end.miles.toFixed(1)} mi
              </span>
            </div>
          )}
        </div>
      )}

      {stops.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {stops.length > 1 && (
            <a href={appleMapsRouteUrl(stops)} className={`${iconBtn} bg-white`}>
              <Ico name="pin" size={13} />
              Open all in Maps
            </a>
          )}
          <button
            type="button"
            onClick={clearDay}
            className="inline-flex min-h-11 items-center rounded-md border border-[#E2DFD5] bg-white px-3 text-[13px] font-medium text-[#8A928C] transition-colors hover:border-[#D8B3AC] hover:text-[#B5372A]"
          >
            Clear route
          </button>
        </div>
      )}

      <AddStop
        accounts={data.accounts}
        inRoute={inRoute}
        onAddAccount={(a) => addEntry(a.id, a.lat, a.lng)}
        onAddCustomStop={(stop) => {
          const id = `custom:${newKey()}`;
          addEntry({ ...stop, id }, stop.lat, stop.lng);
        }}
        onAddCall={(call) => {
          const id = `call:${newKey()}`;
          patchCalls(activeDay, [...calls, { ...call, id }]);
        }}
      />
    </div>
  );
}

function EndpointField({
  label,
  value,
  fallback,
  home,
  onChange,
}: {
  label: string;
  value: RouteEndpoint | null;
  fallback: RouteEndpoint | null;
  home: RouteEndpoint | null;
  onChange: (ep: RouteEndpoint | null) => void;
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
        className="min-h-11 w-40 rounded-md border border-[#8A928C] bg-white px-2 py-1 text-base outline-none"
      />
      {(home || results.length > 0 || searching) && (
        <div className="absolute left-0 top-full z-20 mt-1 max-h-56 w-56 overflow-auto rounded-md border border-[#E2DFD5] bg-white py-1 shadow-lg">
          {home && (
            <button
              type="button"
              onMouseDown={() => {
                onChange(null);
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

function DayBar({
  prefs,
  onChange,
  start,
  end,
  home,
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
          Leave <EndpointField label="Start" value={start} fallback={home} home={home} onChange={onChangeStart} />
          at
          <input type="time" value={prefs.depart} onChange={(e) => onChange({ ...prefs, depart: e.target.value })} className={inputCls} />
        </span>
        <label className="flex items-center gap-1.5">
          <input
            type="number"
            min={1}
            max={240}
            value={prefs.dwellMinutes}
            onChange={(e) => onChange({ ...prefs, dwellMinutes: Number(e.target.value) })}
            className={`${inputCls} w-[4.5rem]`}
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
            className={`${inputCls} w-[4.5rem]`}
          />
          min lunch
        </label>
        <span className="flex items-center gap-1.5">
          Arrive <EndpointField label="End" value={end} fallback={home} home={home} onChange={onChangeEnd} />
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
