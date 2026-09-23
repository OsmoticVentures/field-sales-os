"use client";

/**
 * Fuel. A tank gauge, a destination, then the top three stations on the way
 * by all-in cost: the real posted price plus the true OSRM detour, not a
 * radius search around where the rep is standing. Ported from
 * portfolio/src/app/gas/GasApp.tsx, minus the car-wash mode and the
 * Upside/GasBuddy affiliate links (out of scope for this port, see PORTING.md
 * m8f); the routing and ranking math is unchanged, see
 * lib/features/fuel/{osrm,score}.ts.
 *
 * The write path is now a route handler (api/fuel/find), not the old Server
 * Action, called through apiFetch so the /nb basePath resolves.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { apiFetch } from "@/lib/core/api";
import { Card, Ico } from "../../../lib/core/ui";
import { FAVORITES, GALLON_STEP, TANK_GALLONS } from "../../../lib/features/fuel/constants";
import type { Scored } from "../../../lib/features/fuel/score";

type LatLng = { lat: number; lng: number };
type LocState = "asking" | "ok" | "denied";

const PREFS_KEY = "fuel-stop-v1";
type Prefs = { now: number; fillTo: number; favId: string | null; quickest: boolean; milesToEmpty: number | null };
const DEFAULT_PREFS: Prefs = { now: 4, fillTo: TANK_GALLONS, favId: "home", quickest: false, milesToEmpty: null };

type FindResult =
  | { ok: true; dest: { lat: number; lng: number; address: string; label: string }; directMinutes: number; considered: number; gallons: number; best: Scored[] }
  | { ok: false; error: string };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const snap = (v: number) => Math.round(v / GALLON_STEP) * GALLON_STEP;
const gal = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const usd = (v: number) => `$${v.toFixed(2)}`;

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function appleMapsTwoStops(stop: { name: string; address: string }, destAddress: string): string {
  const s = encodeURIComponent(`${stop.name}, ${stop.address}`);
  const end = encodeURIComponent(destAddress);
  return `https://maps.apple.com/?saddr=Current%20Location&daddr=${s}+to:${end}&dirflg=d`;
}

const inputCls =
  "h-11 w-full rounded-md border border-[#E2DFD5] bg-[#FAF9F5] px-3 text-[16px] text-[#14201B] outline-none placeholder:text-[#8A928C] focus:border-[#14201B]";
const primaryBtn =
  "flex h-14 w-full items-center justify-center rounded-md bg-[#14201B] text-[16px] font-medium text-[#F7F6F1] transition-transform active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100";

export function FuelClient() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [query, setQuery] = useState("");
  const [loc, setLoc] = useState<LatLng | null>(null);
  const [locState, setLocState] = useState<LocState>("asking");
  const [result, setResult] = useState<FindResult | null>(null);
  const [pending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);
  const resultsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setPrefs({ ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) });
    } catch {}
  }, []);
  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const locate = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocState("denied");
      return;
    }
    setLocState("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocState("ok");
      },
      () => setLocState("denied"),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
    );
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    locate();
  }, [locate]);

  const gallons = Math.max(0, snap(prefs.fillTo - prefs.now));
  const fav = FAVORITES.find((f) => f.id === prefs.favId) ?? null;

  const find = () => {
    setFormError(null);
    if (!loc) {
      locate();
      setFormError("Allow location first.");
      return;
    }
    if (gallons < GALLON_STEP) {
      setFormError("Raise the fill-to handle above what's in the tank.");
      return;
    }
    if (!fav && !query.trim()) {
      setFormError("Pick a place or type an address.");
      return;
    }
    const dest = fav ? { lat: fav.lat, lng: fav.lng, address: fav.address, label: fav.label } : { query };
    startTransition(async () => {
      try {
        const res = await apiFetch("/api/fuel/find", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ origin: loc, dest, gallons, quickest: prefs.quickest, milesToEmpty: prefs.milesToEmpty }),
        });
        const j = (await res.json()) as FindResult;
        setResult(j);
      } catch {
        setResult({ ok: false, error: "Couldn't reach the server. Try again." });
      }
      requestAnimationFrame(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">
            <Ico name="gauge" size={13} />
            Tank
          </div>
          <LocationPill state={locState} onRetry={locate} />
        </div>
        <div className="flex gap-5">
          <Gauge now={prefs.now} fillTo={prefs.fillTo} onChange={(now, fillTo) => update({ now, fillTo })} />
          <div className="flex min-w-0 flex-1 flex-col justify-between py-1">
            <div>
              <div className="text-[48px] font-semibold leading-none tracking-tight">{gal(gallons)}</div>
              <div className="mt-1 text-[14px] text-[#5B6560]">gallons to buy</div>
            </div>
            <div className="mt-4 space-y-1.5 text-[13px] text-[#3D4A44]">
              <div>Now {gal(prefs.now)} gal</div>
              <div>Fill to {gal(prefs.fillTo)} gal</div>
            </div>
            <div className="mt-4 flex gap-2">
              <Chip
                active={prefs.fillTo === TANK_GALLONS / 2}
                onClick={() => update({ fillTo: TANK_GALLONS / 2, now: Math.min(prefs.now, TANK_GALLONS / 2 - GALLON_STEP) })}
              >
                Half
              </Chip>
              <Chip active={prefs.fillTo === TANK_GALLONS} onClick={() => update({ fillTo: TANK_GALLONS })}>
                Full
              </Chip>
            </div>
          </div>
        </div>
        <div className="mt-4 border-t border-[#E2DFD5] pt-4">
          <div className="text-[13px] font-medium">Miles to empty</div>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={prefs.milesToEmpty ?? ""}
            onChange={(e) => update({ milesToEmpty: e.target.value === "" ? null : Math.max(0, Number(e.target.value)) })}
            placeholder="Optional"
            className={`${inputCls} mt-2 w-32`}
          />
        </div>
      </Card>

      <Card>
        <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">
          <Ico name="external" size={13} />
          Going to
        </div>
        <div className="flex flex-wrap gap-2">
          {FAVORITES.map((f) => (
            <Chip
              key={f.id}
              active={prefs.favId === f.id}
              onClick={() => {
                update({ favId: f.id });
                setQuery("");
              }}
            >
              {f.label}
            </Chip>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value && prefs.favId) update({ favId: null });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") find();
          }}
          placeholder="Address or area"
          autoComplete="off"
          enterKeyHint="search"
          className={`${inputCls} mt-3`}
        />
        <div className="mt-4 grid grid-cols-2 rounded-md border border-[#E2DFD5] bg-[#FAF9F5] p-1">
          <Segment active={!prefs.quickest} onClick={() => update({ quickest: false })}>
            Cheapest
          </Segment>
          <Segment active={prefs.quickest} onClick={() => update({ quickest: true })}>
            Quickest
          </Segment>
        </div>
      </Card>

      <button type="button" onClick={find} disabled={pending} className={primaryBtn}>
        {pending ? "Checking prices" : "Find gas"}
      </button>
      {formError && <p className="text-[13px] text-[#8A6D2F]">{formError}</p>}

      {result && !pending && (
        <section ref={resultsRef} className="scroll-mt-4">
          {result.ok ? (
            <>
              <div className="text-[19px] font-semibold leading-tight tracking-tight">To {result.dest.label}</div>
              <div className="mt-1 text-[13px] text-[#5B6560]">
                {Math.round(result.directMinutes)} min straight there, {result.considered} stations priced
              </div>
              <ol className="mt-4 flex flex-col gap-3">
                {result.best.map((s, i) => (
                  <StationCard key={s.id} s={s} rank={i + 1} gallons={result.gallons} destAddress={result.dest.address} />
                ))}
              </ol>
            </>
          ) : (
            <p className="text-[14px] text-[#8A6D2F]">{result.error}</p>
          )}
        </section>
      )}
    </div>
  );
}

function StationCard({ s, gallons, destAddress }: { s: Scored; rank: number; gallons: number; destAddress: string }) {
  const minutes = Math.round(s.detourMinutes);
  return (
    <li className="rounded-lg border border-[#E2DFD5] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[16px] font-semibold">{s.name}</div>
          {s.address && <div className="truncate text-[13px] text-[#5B6560]">{s.address}</div>}
        </div>
        <div className="shrink-0 text-right text-[15px] font-semibold">{minutes <= 0 ? "on the way" : `+${minutes} min`}</div>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[34px] font-semibold leading-none tracking-tight">{usd(s.regular)}</span>
        <span className="text-[13px] text-[#5B6560]">per gallon</span>
      </div>
      {s.stale && (
        <div className="mt-2">
          <span className="rounded-full bg-[#8A6D2F]/10 px-2.5 py-1 text-[12px] font-medium text-[#8A6D2F]">Price may be outdated</span>
        </div>
      )}
      <div className="mt-2 text-[13px] text-[#3D4A44]">
        {usd(s.total)} for {gal(gallons)} gal
        {s.updatedAt && <span className={s.stale ? "font-medium text-[#8A6D2F]" : "text-[#8A928C]"}> · price {ago(s.updatedAt)}</span>}
      </div>
      <a
        href={appleMapsTwoStops(s, destAddress)}
        className="mt-3 flex h-11 items-center justify-center rounded-md bg-[#14201B] text-[15px] font-medium text-white transition-transform active:scale-[0.97]"
      >
        Apple Maps
      </a>
    </li>
  );
}

function LocationPill({ state, onRetry }: { state: LocState; onRetry: () => void }) {
  if (state === "ok")
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-[#5B6560]">
        <span className="h-2 w-2 rounded-full bg-[#2C6A46]" />
        Located
      </span>
    );
  if (state === "asking")
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-[#8A928C]">
        <span className="h-2 w-2 animate-pulse rounded-full bg-[#8A928C]" />
        Locating
      </span>
    );
  return (
    <button
      type="button"
      onClick={onRetry}
      className="flex h-9 items-center rounded-full bg-[#14201B] px-4 text-[12.5px] font-medium text-white transition-transform active:scale-[0.97]"
    >
      Allow location
    </button>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-11 items-center rounded-full border px-4 text-[14px] font-medium transition-transform active:scale-[0.97] ${
        active ? "border-[#14201B] bg-[#14201B] text-white" : "border-[#E2DFD5] bg-white text-[#14201B]"
      }`}
    >
      {children}
    </button>
  );
}

function Segment({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex h-11 items-center justify-center rounded text-[14px] font-medium transition-colors ${
        active ? "bg-[#14201B] text-white" : "text-[#5B6560]"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The tank, drawn as a tank. The lower handle is what's in it now, the upper
 * handle is where the fill stops, and the green between them is the fuel
 * about to be bought, which is the only number the ranking cares about.
 * Pointer-captured drag plus arrow-key nudging, unchanged from the source.
 */
function Gauge({ now, fillTo, onChange }: { now: number; fillTo: number; onChange: (now: number, fillTo: number) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<"now" | "fill" | null>(null);

  const valueAt = (clientY: number) => {
    const r = track.current!.getBoundingClientRect();
    const frac = 1 - (clientY - r.top) / r.height;
    return snap(clamp(frac, 0, 1) * TANK_GALLONS);
  };
  const apply = (which: "now" | "fill", v: number) => {
    if (which === "now") onChange(clamp(v, 0, fillTo - GALLON_STEP), fillTo);
    else onChange(now, clamp(v, now + GALLON_STEP, TANK_GALLONS));
  };
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const v = valueAt(e.clientY);
    const which = Math.abs(v - now) <= Math.abs(v - fillTo) ? "now" : "fill";
    drag.current = which;
    e.currentTarget.setPointerCapture(e.pointerId);
    apply(which, v);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const which = drag.current;
    if (which) apply(which, valueAt(e.clientY));
  };
  const onUp = () => {
    drag.current = null;
  };
  const key = (which: "now" | "fill") => (e: React.KeyboardEvent) => {
    const d = e.key === "ArrowUp" || e.key === "ArrowRight" ? GALLON_STEP : e.key === "ArrowDown" || e.key === "ArrowLeft" ? -GALLON_STEP : 0;
    if (!d) return;
    e.preventDefault();
    apply(which, (which === "now" ? now : fillTo) + d);
  };

  const pct = (v: number) => `${(v / TANK_GALLONS) * 100}%`;
  return (
    <div className="flex select-none gap-2">
      <div className="flex h-[240px] flex-col justify-between py-[3px] text-right text-[11px] leading-none text-[#8A928C]">
        <span>Full</span>
        <span>¾</span>
        <span>½</span>
        <span>¼</span>
        <span>0</span>
      </div>
      <div
        ref={track}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        className="relative h-[240px] w-[56px] cursor-pointer touch-none rounded-2xl border border-[#E2DFD5] bg-[#ECEAE1]"
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <span key={f} className="absolute left-0 right-0 h-px bg-white" style={{ bottom: `${f * 100}%` }} />
        ))}
        <div className="absolute inset-x-0 bottom-0 rounded-b-[15px] bg-[#C9CFCB]" style={{ height: pct(now) }} />
        <div className="absolute inset-x-0 bg-[#2C6A46]" style={{ bottom: pct(now), height: pct(fillTo - now), borderRadius: fillTo === TANK_GALLONS ? "15px 15px 0 0" : 0 }} />
        <Thumb value={now} label={`Now, ${gal(now)} gallons`} bottom={pct(now)} onKeyDown={key("now")} />
        <Thumb value={fillTo} label={`Fill to, ${gal(fillTo)} gallons`} bottom={pct(fillTo)} onKeyDown={key("fill")} />
      </div>
    </div>
  );
}

function Thumb({ value, label, bottom, onKeyDown }: { value: number; label: string; bottom: string; onKeyDown: (e: React.KeyboardEvent) => void }) {
  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={TANK_GALLONS}
      aria-valuenow={value}
      onKeyDown={onKeyDown}
      className="absolute left-1/2 h-8 w-[68px] -translate-x-1/2 translate-y-1/2 rounded-full border border-[#E2DFD5] bg-white shadow-[0_1px_4px_rgba(20,32,27,0.18)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2C6A46]"
      style={{ bottom }}
    >
      <span className="absolute left-1/2 top-1/2 h-1 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#C9CFCB]" />
    </div>
  );
}
