"use client";

/**
 * The territory map: every account in Juan's book as a pin, the source
 * app's filter chips, and its pin card, folded into the Route screen's map
 * (replaces the day-only RouteMap.tsx). Ported from the NutriBiotic OS's
 * map/AccountsMap.tsx and map/MapScreen.tsx, vanilla google.maps as this
 * repo's own RouteMap.tsx already used, no @react-google-maps/api
 * dependency added.
 *
 * FILTERING NEVER HIDES A ROUTE STOP'S PIN (source commit 7079768): the
 * active day's stops are drawn even when a chip would otherwise exclude
 * their account, so the numbered sequence never gaps.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Geolocation } from "@capacitor/geolocation";
import { apiFetch } from "@/lib/core/api";
import { Ico } from "@/lib/core/ui";
import { loadGoogleMaps } from "@/lib/shared/google-maps-loader";
import { dayLabel } from "@/lib/features/route/field-week";
import {
  accountType,
  ACCOUNT_TYPE_LABEL,
  ACCOUNT_TYPES,
  activeFilterCount,
  countSubjects,
  emptyFilters,
  HOT_SCORE_MIN,
  isSmallPractice,
  LEAD_STAGE_COLOR,
  LEAD_STAGE_LABEL,
  LEAD_STAGES,
  matchesFilters,
  READINESS_COLOR,
  READINESS_FILTERS,
  READINESS_LABEL,
  type AccountFilterState,
  type AccountType,
  type ReadinessFilter,
} from "@/lib/features/route/account-filters";
import type {
  AccountPriority,
  MapDisplayPrefs,
  RouteAccount,
  RouteEndpoint,
  RouteStopView,
  Tier,
} from "@/lib/features/route/types";
import type { SdrPriority, TerritoryArea } from "@/lib/features/prospect/dal";
import { absoluteUrl, prettyPhone, prettyUrl, realChannel } from "@/lib/features/clients/ui";
import { HUBSPOT_COMPANY_URL } from "@/lib/features/prospect/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
type G = any;

const FALLBACK_CENTER = { lat: 34.0195, lng: -118.4912 };

const MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#f3f1ea" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8a928c" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#f7f6f1" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#d8d4c8" }] },
  { featureType: "landscape", elementType: "geometry", stylers: [{ color: "#f3f1ea" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#ede9dc" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#dde4e0" }] },
];

/** Same ramp the source pins wear: cools as HQ potential capacity falls. */
const POTENTIAL_COLOR: Partial<Record<Tier, string>> = {
  A: "#B5372A",
  B: "#B5372A",
  C: "#D97E2B",
  D: "#C79A1E",
  E: "#8A928C",
};

const TIERS: Tier[] = ["A", "B", "C", "D", "E", "F", "G"];

const SDR_PRIORITIES: { value: SdrPriority; label: string; tone: string }[] = [
  { value: "low", label: "Low", tone: "bg-[#ECEAE1] text-[#5B6560] hover:bg-[#E2DFD5]" },
  { value: "mid", label: "Mid", tone: "bg-[#E7EDE4] text-[#3D6B4A] hover:bg-[#DCE6D8]" },
  { value: "high", label: "High", tone: "bg-[#F3E3C6] text-[#8A6D2F] hover:bg-[#EDD8AD]" },
];

const EIGHTEEN_MONTHS_DAYS = 548;
/** "487d ago" while the purchase is recent enough that a day count means
 *  something, "3y ago" once it isn't. Same 18-month cutoff the source's
 *  lead-stage view draws. */
function lastOrderAge(iso: string | null): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days <= EIGHTEEN_MONTHS_DAYS) return `${days}d ago`;
  return `${Math.round(days / 365)}y ago`;
}
/** Null renders absent, never a fake $0 (hard rule 1). */
function usd(n: number | null): string | null {
  if (n === null || n === undefined) return null;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function isProspect(a: Pick<RouteAccount, "lead_stage">): boolean {
  return a.lead_stage === "prospect";
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  return res.json().catch(() => ({ ok: false, error: "Could not save that." }));
}

/**
 * A day off the horizon as one tap: Today big and primary, the rest of the
 * horizon as small chips, no confirm step behind either (source commit
 * 5b74f33).
 */
function DayButtons({ days, onPick, disabled }: { days: string[]; onPick: (day: string) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => onPick(days[0])}
        disabled={disabled}
        className="min-h-11 rounded-md bg-[#2C6A46] px-3.5 py-2 text-[13px] font-semibold text-white transition-transform active:scale-[0.97] disabled:opacity-40"
      >
        Today
      </button>
      {days.slice(1).map((d) => {
        const { weekday, short } = dayLabel(d);
        return (
          <button
            key={d}
            type="button"
            onClick={() => onPick(d)}
            disabled={disabled}
            className="min-h-9 rounded-md border border-[#E2DFD5] bg-white px-2 py-1.5 text-[11.5px] font-medium text-[#3D4A44] transition-colors hover:bg-[#FAF9F5] disabled:opacity-40"
          >
            {weekday} {short}
          </button>
        );
      })}
    </div>
  );
}

function AddToRouteDay({
  accountId,
  lat,
  lng,
  days,
  scheduledDay,
  onPick,
}: {
  accountId: string;
  lat: number;
  lng: number;
  days: string[];
  scheduledDay: string | null;
  onPick: (id: string, day: string, lat: number, lng: number) => void;
}) {
  const [open, setOpen] = useState(false);

  if (scheduledDay) {
    const { weekday, short } = dayLabel(scheduledDay);
    return (
      <div className="mt-2 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-[#EEECE3] px-3 py-2 text-[13px] font-semibold text-[#5B6560]">
        <Ico name="check" size={13} />
        On the route &middot; {weekday} {short}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-[#2C6A46] px-3 py-2 text-[13px] font-semibold text-white transition-transform active:scale-[0.97]"
      >
        <Ico name="route" size={13} />
        Add to route
      </button>
    );
  }

  return (
    <div className="mt-2">
      <DayButtons
        days={days}
        onPick={(day) => {
          onPick(accountId, day, lat, lng);
          setOpen(false);
        }}
      />
    </div>
  );
}

function AddToSdr({ accountId, days }: { accountId: string; days: string[] }) {
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState<SdrPriority | null>(null);
  const [queued, setQueued] = useState<{ priority: SdrPriority; day: string } | null>(null);
  const [failReason, setFailReason] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function queue(day: string) {
    if (!priority) return;
    setBusy(true);
    setFailReason(null);
    const res = await postJson("/api/prospect/schedule", { account_id: accountId, kind: "call", scheduled_date: day, priority });
    setBusy(false);
    if (res.ok) {
      setQueued({ priority, day });
      setOpen(false);
    } else {
      setFailReason(res.error ?? "Could not queue it.");
    }
  }

  if (queued) {
    const { weekday, short } = dayLabel(queued.day);
    return (
      <div className="mt-1.5 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md bg-[#EEECE3] px-3 py-2 text-[13px] font-semibold text-[#5B6560]">
        <Ico name="check" size={13} />
        In the SDR queue &middot; {queued.priority} &middot; {weekday} {short}
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-1.5">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md border border-[#E2DFD5] bg-white px-3 py-2 text-[13px] font-semibold text-[#3D4A44] transition-colors hover:bg-[#FAF9F5]"
        >
          <Ico name="phone" size={13} />
          Add to SDR
        </button>
        {failReason && <div className="mt-1 text-[11.5px] text-[#8A2E2E]">Not scheduled: {failReason}</div>}
      </div>
    );
  }

  if (!priority) {
    return (
      <div className="mt-1.5 flex items-center gap-1.5">
        {SDR_PRIORITIES.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => setPriority(p.value)}
            className={`min-h-11 flex-1 rounded-md px-2 py-2 text-[12.5px] font-semibold transition-colors ${p.tone}`}
          >
            {p.label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-1.5">
      <DayButtons days={days} onPick={queue} disabled={busy} />
      {failReason && <div className="mt-1 text-[11.5px] text-[#8A2E2E]">Not scheduled: {failReason}</div>}
    </div>
  );
}

export function AccountsMap({
  accounts,
  days,
  activeDay,
  draftByDay,
  stops,
  start,
  end,
  coords,
  doneIds,
  focus,
  onAddToRouteOnDay,
}: {
  /** Juan's whole owned book, from /api/route/state (RouteAccount, already
   *  carrying the map's extra fields). */
  accounts: RouteAccount[];
  days: string[];
  activeDay: string;
  /** Every day's hand-built stop list, ids and custom stops, for "already
   *  on the route" across the whole horizon, not just the active day. */
  draftByDay: Record<string, (string | { id: string })[]>;
  /** The active day's ordered stops, for numbering and the never-hide rule. */
  stops: RouteStopView[];
  start: RouteEndpoint | null;
  end: RouteEndpoint | null;
  coords: [number, number][] | null;
  doneIds: Set<string>;
  focus?: { id: string; n: number } | null;
  /** Names the exact day: today keeps RouteClient's own cheapest-insertion
   *  order, any other day just appends (mirrors the source's
   *  handleAddToRouteOnDay in MapScreen.tsx). */
  onAddToRouteOnDay: (id: string, day: string, lat: number, lng: number) => void;
}) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<G>(null);
  const markersRef = useRef<G[]>([]);
  const lineRef = useRef<G>(null);
  const meRef = useRef<G>(null);
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);

  const [areas, setAreas] = useState<TerritoryArea[]>([]);
  const [priorityById, setPriorityById] = useState<Record<string, AccountPriority>>({});
  const [displayPrefs, setDisplayPrefs] = useState<MapDisplayPrefs>({ showChains: false, showPractices: false, showProspects: false });

  useEffect(() => {
    apiFetch("/api/route/map")
      .then((r) => r.json())
      .then((j: { ok: boolean; areas?: TerritoryArea[]; priorityById?: Record<string, AccountPriority>; displayPrefs?: MapDisplayPrefs }) => {
        if (!j.ok) return;
        setAreas(j.areas ?? []);
        setPriorityById(j.priorityById ?? {});
        if (j.displayPrefs) setDisplayPrefs(j.displayPrefs);
      })
      .catch(() => {});
  }, []);

  function patchDisplayPref(pref: "chains" | "practices" | "prospects", show: boolean) {
    const key = pref === "chains" ? "showChains" : pref === "practices" ? "showPractices" : "showProspects";
    setDisplayPrefs((prev) => ({ ...prev, [key]: show }));
    postJson("/api/route/map-prefs", { pref, show }).catch(() => setDisplayPrefs((prev) => ({ ...prev, [key]: !show })));
  }

  const [filters, setFilters] = useState<AccountFilterState>(emptyFilters());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<RouteAccount | null>(null);

  const areaById = useMemo(() => new Map(areas.map((a) => [a.id, a])), [areas]);

  /** Which day (across the whole horizon, not just the active one) an
   *  account is already scheduled on, if any. */
  const stopDayById = useMemo(() => {
    const m = new Map<string, string>();
    for (const day of days) {
      for (const e of draftByDay[day] ?? []) {
        const id = typeof e === "string" ? e : e.id;
        if (!m.has(id)) m.set(id, day);
      }
    }
    return m;
  }, [days, draftByDay]);

  const visibleAccounts = useMemo(
    () =>
      accounts.filter(
        (a) =>
          (displayPrefs.showChains || !a.chain_excluded) &&
          (displayPrefs.showPractices || !isSmallPractice(a.channel, a.tier)) &&
          a.lead_status !== "Closed" &&
          (displayPrefs.showProspects || !isProspect(a)),
      ),
    [accounts, displayPrefs],
  );

  const subjects = useMemo(
    () =>
      visibleAccounts
        .filter((a) => a.lifecycle !== "waypoint")
        .map((a) => ({
          id: a.id,
          area: a.area,
          tier: a.tier,
          readiness: a.readiness,
          score: priorityById[a.id]?.score ?? null,
          channel: a.channel,
          leadStage: a.lead_stage,
        })),
    [visibleAccounts, priorityById],
  );
  const counts = useMemo(() => countSubjects(subjects), [subjects]);

  const filtered = useMemo(
    () =>
      visibleAccounts.filter((a) =>
        matchesFilters(filters, {
          id: a.id,
          area: a.area,
          tier: a.tier,
          readiness: a.readiness,
          score: priorityById[a.id]?.score ?? null,
          channel: a.channel,
          leadStage: a.lead_stage,
        }),
      ),
    [visibleAccounts, filters, priorityById],
  );

  const accountsById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  /* THE NEVER-HIDE RULE (source commit 7079768): the active day's charted
     stops stay on the map even when a chip would otherwise exclude their
     account, so the numbered sequence never gaps. */
  const pinAccounts = useMemo(() => {
    if (stops.length === 0) return filtered;
    const shown = new Set(filtered.map((a) => a.id));
    const missing = stops
      .map((s) => (s.type === "account" ? accountsById.get(s.id) : null))
      .filter((a): a is RouteAccount => a != null && !shown.has(a.id));
    return missing.length > 0 ? [...filtered, ...missing] : filtered;
  }, [filtered, stops, accountsById]);

  const routeNumberById = useMemo(() => {
    const m = new Map<string, number>();
    stops.forEach((s, i) => m.set(s.id, i + 1));
    return m;
  }, [stops]);

  const chainExcludedCount = useMemo(() => accounts.filter((a) => a.chain_excluded).length, [accounts]);
  const practiceExcludedCount = useMemo(() => accounts.filter((a) => isSmallPractice(a.channel, a.tier)).length, [accounts]);
  const prospectExcludedCount = useMemo(() => accounts.filter((a) => isProspect(a)).length, [accounts]);

  function toggle<T>(set: Set<T>, v: T): Set<T> {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  }
  function setFiltersAndClose(next: AccountFilterState) {
    setSelected(null);
    setFilters(next);
  }

  // Google reports a rejected key through this global hook after the
  // script itself loaded fine.
  useEffect(() => {
    const w = window as unknown as { gm_authFailure?: () => void; __gmAuthFailed?: boolean };
    if (w.__gmAuthFailed) {
      setFailed(true);
      return;
    }
    const prev = w.gm_authFailure;
    w.gm_authFailure = () => {
      w.__gmAuthFailed = true;
      prev?.();
      setFailed(true);
    };
    return () => {
      if (w.gm_authFailure && !w.__gmAuthFailed) w.gm_authFailure = prev;
    };
  }, []);

  useEffect(() => {
    if (!apiKey || !containerRef.current) return;
    let cancelled = false;
    loadGoogleMaps(apiKey)
      .then((g) => {
        if (cancelled || !containerRef.current) return;
        mapRef.current = new g.maps.Map(containerRef.current, {
          center: FALLBACK_CENTER,
          zoom: 9,
          styles: MAP_STYLE,
          disableDefaultUI: true,
          zoomControl: true,
          // Two-finger pan on a touch device so the map never traps a
          // one-finger page scroll.
          gestureHandling: "cooperative",
          keyboardShortcuts: false,
        });
        setLoaded(true);
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [apiKey]);

  useEffect(() => {
    let cancelled = false;
    Geolocation.getCurrentPosition({ timeout: 8000, maximumAge: 600_000 })
      .then((pos) => {
        if (!cancelled) setMe({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const fittedRef = useRef("");
  const fitKey = useMemo(() => pinAccounts.map((a) => a.id).join(","), [pinAccounts]);
  const routeFitKey = useMemo(
    () =>
      [
        ...(start ? [`s:${start.lat},${start.lng}`] : []),
        ...stops.map((s) => `${s.id}:${s.lat},${s.lng}`),
        ...(end ? [`e:${end.lat},${end.lng}`] : []),
      ].join("|"),
    [stops, start, end],
  );
  const areaFitKey = useMemo(() => [...filters.areas].sort().join(","), [filters.areas]);

  const fitToPins = useCallback(() => {
    const g = typeof window !== "undefined" ? (window as unknown as { google?: G }).google : null;
    const map = mapRef.current;
    if (!g || !map) return;

    // An area chip outranks the day's route, which outranks the whole book
    // (source's own order, after the auto-zoom fix documented there).
    if (filters.areas.size > 0) {
      const key = `area:${areaFitKey}`;
      if (fittedRef.current === key) return;
      const bounds = new g.maps.LatLngBounds();
      let points = 0;
      for (const a of pinAccounts) {
        if (!filters.areas.has(a.area ?? "")) continue;
        bounds.extend({ lat: a.lat, lng: a.lng });
        points += 1;
      }
      if (points > 0) {
        map.fitBounds(bounds, 32);
        fittedRef.current = key;
      }
      return;
    }

    if (stops.length > 0) {
      const key = `route:${routeFitKey}`;
      if (fittedRef.current === key) return;
      const bounds = new g.maps.LatLngBounds();
      for (const s of stops) bounds.extend({ lat: s.lat, lng: s.lng });
      if (start) bounds.extend({ lat: start.lat, lng: start.lng });
      if (end) bounds.extend({ lat: end.lat, lng: end.lng });
      map.fitBounds(bounds, 48);
      fittedRef.current = key;
      return;
    }

    if (pinAccounts.length === 0 || fittedRef.current === fitKey) return;
    const bounds = new g.maps.LatLngBounds();
    for (const a of pinAccounts) bounds.extend({ lat: a.lat, lng: a.lng });
    map.fitBounds(bounds, 40);
    fittedRef.current = fitKey;
  }, [pinAccounts, fitKey, stops, routeFitKey, start, end, filters.areas, areaFitKey]);

  useEffect(() => {
    fittedRef.current = "";
    fitToPins();
  }, [fitKey, routeFitKey, areaFitKey, loaded, fitToPins]);

  // Pins, rings and the road shape, redrawn whenever the day or the filtered
  // set changes.
  useEffect(() => {
    const g = typeof window !== "undefined" ? (window as unknown as { google?: G }).google : null;
    const map = mapRef.current;
    if (!g || !map || !loaded) return;

    for (const m of markersRef.current) m.setMap(null);
    markersRef.current = [];
    if (lineRef.current) {
      lineRef.current.setMap(null);
      lineRef.current = null;
    }

    const ring = (p: RouteEndpoint, title: string) => {
      const marker = new g.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        map,
        title,
        icon: { path: g.maps.SymbolPath.CIRCLE, scale: 8, fillColor: "#F7F6F1", fillOpacity: 1, strokeColor: "#14201B", strokeWeight: 2.5 },
        zIndex: 8,
      });
      markersRef.current.push(marker);
    };
    if (start) ring(start, `Start: ${start.label}`);
    if (end && (!start || end.lat !== start.lat || end.lng !== start.lng)) ring(end, `End: ${end.label}`);

    for (const a of pinAccounts) {
      const prospect = isProspect(a);
      const potential = !prospect && a.tier ? POTENTIAL_COLOR[a.tier] : undefined;
      const routeNum = routeNumberById.get(a.id);
      const done = routeNum ? doneIds.has(a.id) : false;
      const fillColor = done
        ? "#8A928C"
        : routeNum
          ? "#14201B"
          : prospect
            ? LEAD_STAGE_COLOR.prospect
            : (potential ?? (a.area && areaById.get(a.area)?.color) ?? "#5B6560");
      const marker = new g.maps.Marker({
        position: { lat: a.lat, lng: a.lng },
        map,
        opacity: a.do_not_visit ? 0.45 : 1,
        title: a.name,
        zIndex: routeNum ? 6 : potential ? 3 : 2,
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: routeNum ? 11 : potential ? 7 : 6,
          fillColor,
          fillOpacity: 1,
          strokeColor: "#F7F6F1",
          strokeWeight: routeNum ? 2 : 1.5,
        },
        label: routeNum ? { text: String(routeNum), color: "#F7F6F1", fontSize: "11px", fontWeight: "700" } : undefined,
      });
      marker.addListener("click", () => setSelected(a));
      markersRef.current.push(marker);
    }

    // Route stops that are not accounts: lunch, the hotel, a warehouse.
    // Drawn as a square, never a circle, same distinction the source draws:
    // nothing on this map should read as "an account" unless it is one.
    for (const s of stops) {
      if (s.type !== "custom") continue;
      const routeNum = routeNumberById.get(s.id);
      const done = doneIds.has(s.id);
      const marker = new g.maps.Marker({
        position: { lat: s.lat, lng: s.lng },
        map,
        title: s.custom.label,
        zIndex: routeNum ? 6 : 3,
        icon: {
          path: "M -6 -6 L 6 -6 L 6 6 L -6 6 Z",
          scale: routeNum ? 1.9 : 1,
          fillColor: done ? "#8A928C" : "#A0762C",
          fillOpacity: 1,
          strokeColor: "#F7F6F1",
          strokeWeight: routeNum ? 2 : 1.5,
        },
        label: routeNum ? { text: String(routeNum), color: "#F7F6F1", fontSize: "11px", fontWeight: "700" } : undefined,
      });
      markersRef.current.push(marker);
    }

    if (coords && coords.length > 1) {
      lineRef.current = new g.maps.Polyline({
        path: coords.map(([lng, lat]) => ({ lat, lng })),
        map,
        strokeColor: "#14201B",
        strokeOpacity: 0.7,
        strokeWeight: 3,
        clickable: false,
        zIndex: 4,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinAccounts, stops, routeNumberById, doneIds, coords, start, end, loaded, areaById]);

  // The rep's own dot, kept separate so a location fix never refits the view.
  useEffect(() => {
    const g = typeof window !== "undefined" ? (window as unknown as { google?: G }).google : null;
    const map = mapRef.current;
    if (!g || !map || !loaded) return;
    if (meRef.current) {
      meRef.current.setMap(null);
      meRef.current = null;
    }
    if (!me) return;
    meRef.current = new g.maps.Marker({
      position: me,
      map,
      title: "You",
      icon: { path: g.maps.SymbolPath.CIRCLE, scale: 7, fillColor: "#1A73E8", fillOpacity: 1, strokeColor: "#FFFFFF", strokeWeight: 2.5 },
      zIndex: 7,
    });
  }, [me, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!focus || !map || !loaded) return;
    const a = accountsById.get(focus.id);
    if (a) {
      setSelected(a);
      map.panTo({ lat: a.lat, lng: a.lng });
      map.setZoom(14);
      return;
    }
    // A custom stop (lunch, hotel) carries no pin card, same as before this
    // port: it is not an account, only pan/zoom to it.
    const custom = stops.find((s) => s.id === focus.id);
    if (!custom) return;
    map.panTo({ lat: custom.lat, lng: custom.lng });
    map.setZoom(14);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, loaded]);

  if (!apiKey || failed) {
    return (
      <div className="flex min-h-11 items-center gap-2 rounded-lg border border-[#E2DFD5] bg-white px-4 py-3 text-[13px] text-[#8A928C]">
        Map unavailable
      </div>
    );
  }

  const filterCount = activeFilterCount(filters);

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-[#E2DFD5] bg-white">
        <button
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
          className="flex min-h-11 w-full items-center justify-between gap-2 px-3.5 py-2 text-[13px] font-medium text-[#3D4A44] md:hidden"
        >
          <span>
            Filters{filterCount > 0 ? ` (${filterCount})` : ""}
          </span>
          <span className="text-[12.5px] text-[#8A928C]">
            {filtered.length} of {accounts.length}
          </span>
        </button>

        <div className={`${filtersOpen ? "block" : "hidden"} md:block`}>
          <FilterSection label="Areas" onClear={filters.areas.size > 0 ? () => setFiltersAndClose({ ...filters, areas: new Set() }) : undefined}>
            {areas.map((a) => (
              <Chip
                key={a.id}
                active={filters.areas.has(a.id)}
                dot={a.color}
                onClick={() => setFiltersAndClose({ ...filters, areas: toggle(filters.areas, a.id) })}
              >
                {a.label} <Count n={counts.areas[a.id] ?? 0} />
              </Chip>
            ))}
          </FilterSection>

          <FilterSection label="Tier" onClear={filters.tiers.size > 0 ? () => setFiltersAndClose({ ...filters, tiers: new Set() }) : undefined}>
            {TIERS.map((t) => (
              <Chip
                key={t}
                active={filters.tiers.has(t)}
                dot={POTENTIAL_COLOR[t] ?? "#8A928C"}
                onClick={() => setFiltersAndClose({ ...filters, tiers: toggle(filters.tiers, t) })}
              >
                {t} <Count n={counts.tiers[t] ?? 0} />
              </Chip>
            ))}
          </FilterSection>

          <FilterSection
            label="Readiness"
            onClear={filters.readiness.size > 0 || filters.hotScore ? () => setFiltersAndClose({ ...filters, readiness: new Set(), hotScore: false }) : undefined}
          >
            {READINESS_FILTERS.map((r) => (
              <Chip
                key={r}
                active={filters.readiness.has(r)}
                dot={READINESS_COLOR[r]}
                onClick={() => setFiltersAndClose({ ...filters, readiness: toggle(filters.readiness, r) })}
              >
                {READINESS_LABEL[r]} <Count n={counts.readiness[r] ?? 0} />
              </Chip>
            ))}
            <Chip active={filters.hotScore} onClick={() => setFiltersAndClose({ ...filters, hotScore: !filters.hotScore })}>
              {HOT_SCORE_MIN}+ score <Count n={counts.hotScore} />
            </Chip>
          </FilterSection>

          <FilterSection label="Type" onClear={filters.types.size > 0 ? () => setFiltersAndClose({ ...filters, types: new Set() }) : undefined}>
            {ACCOUNT_TYPES.map((t) => (
              <Chip
                key={t}
                active={filters.types.has(t)}
                onClick={() => setFiltersAndClose({ ...filters, types: toggle(filters.types, t) })}
              >
                {ACCOUNT_TYPE_LABEL[t]} <Count n={counts.types[t] ?? 0} />
              </Chip>
            ))}
            {chainExcludedCount > 0 && (
              <HideToggle
                shown={displayPrefs.showChains}
                onToggle={() => patchDisplayPref("chains", !displayPrefs.showChains)}
                shownLabel="Chains shown"
                hiddenLabel="Chains hidden"
                count={chainExcludedCount}
              />
            )}
            {practiceExcludedCount > 0 && (
              <HideToggle
                shown={displayPrefs.showPractices}
                onToggle={() => patchDisplayPref("practices", !displayPrefs.showPractices)}
                shownLabel="Practices shown"
                hiddenLabel="Practices hidden"
                count={practiceExcludedCount}
              />
            )}
          </FilterSection>

          <FilterSection label="Lead status" onClear={filters.stages.size > 0 ? () => setFiltersAndClose({ ...filters, stages: new Set() }) : undefined}>
            {LEAD_STAGES.map((s) => (
              <Chip
                key={s}
                active={filters.stages.has(s)}
                dot={LEAD_STAGE_COLOR[s]}
                onClick={() => setFiltersAndClose({ ...filters, stages: toggle(filters.stages, s) })}
              >
                {LEAD_STAGE_LABEL[s]} <Count n={counts.stages[s] ?? 0} />
              </Chip>
            ))}
            {prospectExcludedCount > 0 && (
              <HideToggle
                shown={displayPrefs.showProspects}
                onToggle={() => patchDisplayPref("prospects", !displayPrefs.showProspects)}
                shownLabel="Prospects shown"
                hiddenLabel="Prospects hidden"
                count={prospectExcludedCount}
              />
            )}
          </FilterSection>

          <div className="hidden items-center justify-end px-3.5 py-1.5 text-[12px] text-[#8A928C] md:flex">
            {filtered.length} of {accounts.length} accounts
          </div>
        </div>
      </div>

      <div className="relative h-[300px] overflow-hidden rounded-lg border border-[#E2DFD5] bg-white md:h-[420px]">
        <div ref={containerRef} className="absolute inset-0" />
        {!loaded && <div className="absolute inset-0 animate-pulse bg-[#EDEBE3] motion-reduce:animate-none" />}
      </div>

      {selected && (
        <AccountPinCard
          account={selected}
          priority={priorityById[selected.id]}
          area={selected.area ? areaById.get(selected.area) : undefined}
          days={days}
          scheduledDay={stopDayById.get(selected.id) ?? null}
          onAddToRouteOnDay={onAddToRouteOnDay}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function FilterSection({ label, onClear, children }: { label: string; onClear?: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-1.5 gap-y-1.5 border-b border-[#EEECE3] px-3.5 py-2">
      <span className="mt-1 w-[74px] shrink-0 text-[10.5px] font-medium uppercase tracking-[0.06em] text-[#8A928C]">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
      {onClear && (
        <button type="button" onClick={onClear} className="mt-0.5 shrink-0 rounded-md px-2 py-1 text-[12px] text-[#8A928C] underline-offset-2 hover:text-[#3D4A44] hover:underline">
          clear
        </button>
      )}
    </div>
  );
}

function Chip({ active, dot, onClick, children }: { active: boolean; dot?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
        active ? "border-[#14201B] bg-[#14201B] text-[#F7F6F1]" : "border-[#E2DFD5] bg-white text-[#3D4A44] hover:bg-[#FAF9F5]"
      }`}
    >
      {dot && <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />}
      {children}
    </button>
  );
}

function Count({ n }: { n: number }) {
  return <span className="tabular-nums opacity-70">{n}</span>;
}

function HideToggle({
  shown,
  onToggle,
  shownLabel,
  hiddenLabel,
  count,
}: {
  shown: boolean;
  onToggle: () => void;
  shownLabel: string;
  hiddenLabel: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={shown}
      className={`inline-flex min-h-9 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
        shown ? "border-[#14201B] bg-[#14201B] text-[#F7F6F1]" : "border-[#E2DFD5] bg-white text-[#3D4A44] hover:bg-[#FAF9F5]"
      }`}
    >
      {shown ? shownLabel : hiddenLabel} <Count n={count} />
    </button>
  );
}

function AccountPinCard({
  account: a,
  priority,
  area,
  days,
  scheduledDay,
  onAddToRouteOnDay,
  onClose,
}: {
  account: RouteAccount;
  priority?: AccountPriority;
  area?: TerritoryArea;
  days: string[];
  scheduledDay: string | null;
  onAddToRouteOnDay: (id: string, day: string, lat: number, lng: number) => void;
  onClose: () => void;
}) {
  const lifetime = usd(a.lifetime_revenue);
  const orderAge = lastOrderAge(a.last_order_at);
  return (
    <div className="rounded-lg border border-[#E2DFD5] bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-[15px] font-semibold text-[#14201B]">{a.name}</span>
            {a.tier && (
              <span
                className="inline-flex h-[19px] w-[19px] items-center justify-center rounded text-[11px] font-bold text-white"
                style={{ background: POTENTIAL_COLOR[a.tier] ?? "#8A928C" }}
                title={`HQ potential ${a.tier}`}
              >
                {a.tier}
              </span>
            )}
            {priority && (
              <span
                className={`rounded px-1.5 py-0.5 text-[11px] font-bold tabular-nums ${priority.band === "now" ? "bg-[#F3E3C6] text-[#8A6D2F]" : "bg-[#ECEAE1] text-[#5B6560]"}`}
                title={priority.reason}
              >
                {priority.score}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px]">
            {realChannel(a.channel) && <span className="text-[#5B6560]">{realChannel(a.channel)}</span>}
            {area && (
              <span className="rounded-full px-1.5 py-0.5 text-[10.5px] font-medium text-white" style={{ background: area.color }}>
                {area.label}
              </span>
            )}
            {a.lead_stage && (
              <span className="rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-white" style={{ background: LEAD_STAGE_COLOR[a.lead_stage] }}>
                {LEAD_STAGE_LABEL[a.lead_stage]}
              </span>
            )}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="flex min-h-9 min-w-9 items-center justify-center rounded-md text-[#8A928C] hover:bg-[#FAF9F5] hover:text-[#14201B]">
          <Ico name="close" size={13} />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-[#5B6560]">
        {lifetime && <span className="font-medium text-[#14201B]">{lifetime} lifetime</span>}
        {orderAge && (
          <>
            {lifetime && <span>&middot;</span>}
            <span>last order {orderAge}</span>
          </>
        )}
      </div>

      {a.do_not_visit && <div className="mt-1 text-[11.5px] text-[#A0762C]">do not visit</div>}

      <AddToRouteDay key={`route-${a.id}`} accountId={a.id} lat={a.lat} lng={a.lng} days={days} scheduledDay={scheduledDay} onPick={onAddToRouteOnDay} />
      <AddToSdr key={`sdr-${a.id}`} accountId={a.id} days={days} />

      <div className="mt-2 flex flex-wrap items-center gap-3 text-[12.5px]">
        <Link href={`/account/${a.id}`} className="font-medium text-[#3D4A44] underline-offset-2 hover:underline">
          View account
        </Link>
        {a.hubspot_company_id && (
          <a href={HUBSPOT_COMPANY_URL(a.hubspot_company_id)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1 font-medium text-[#3D4A44] hover:underline">
            <Ico name="hubspot" size={12} />
            HubSpot
          </a>
        )}
        {a.website && (
          <a href={absoluteUrl(a.website)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 min-w-0 items-center gap-1 font-medium text-[#3D4A44] hover:underline">
            <Ico name="globe" size={12} />
            <span className="max-w-[22ch] truncate">{prettyUrl(a.website)}</span>
          </a>
        )}
        {a.phone && (
          <a href={`tel:${a.phone}`} className="inline-flex min-h-8 items-center gap-1 font-medium tabular-nums text-[#3D4A44] hover:underline">
            <Ico name="phone" size={12} />
            {prettyPhone(a.phone)}
          </a>
        )}
      </div>
    </div>
  );
}
