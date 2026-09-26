"use client";

/**
 * Plan week: the route planner running inside the app, no Mac needed. Reads
 * a proposed drivable week from /api/planner/propose (geography, business
 * hours, the ~3h drive cap and the ~10-stop cap already applied, every
 * return-visit promise honoured, per src/lib/features/planner/plan.ts) and
 * lets Juan put a day on his route with one tap.
 *
 * ONE-HANDED AT A RED LIGHT. A day is a plain vertical timeline: arrive
 * time, name, the one line why it's there, an Apple Maps tap target. No
 * caption explains the screen; the numbers are the explanation.
 */

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/core/api";
import { Card, Ico, SuccessNote, displayFace, eyebrowCls, ghostBtn, primaryBtn } from "@/lib/core/ui";
import { dayLabel } from "@/lib/features/route/field-week";
import type { PlannedDay, PlannedStop, ProposedWeek, UnroutableEntry } from "@/lib/features/planner/types";

type ProposeResponse =
  | { ok: true; status: "ok"; week: ProposedWeek }
  | { ok: true; status: "blocked"; reason: string; week: null }
  | { ok: false; error: string };

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

function fmtClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m ? `${h12}:${String(m).padStart(2, "0")}${period}` : `${h12}${period}`;
}

const KIND_LABEL: Record<PlannedStop["kind"], string> = {
  anchor: "Return, timed",
  return: "Return visit",
  due: "Due",
};

const REASON_LABEL: Record<UnroutableEntry["reason"], string> = {
  "no coordinates": "No coordinates on file",
  closed: "Closed",
  "do not visit": "Do not visit",
  "corporate-gated": "Corporate approval required",
  "corrupt hours": "Hours on file don't make sense",
};

export function PlanWeekClient() {
  const [week, setWeek] = useState<ProposedWeek | null>(null);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/planner/propose")
      .then((r) => r.json())
      .then((j: ProposeResponse) => {
        if (cancelled) return;
        if (!j.ok) {
          setError(j.error);
        } else if (j.status === "blocked") {
          setBlockedReason(j.reason);
        } else {
          setWeek(j.week);
        }
      })
      .catch(() => !cancelled && setError("Couldn't load a plan right now."))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  function removeDay(date: string) {
    setWeek((w) => (w ? { ...w, days: w.days.filter((d) => d.date !== date) } : w));
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="h-24 w-full animate-pulse rounded-lg bg-[#EDEBE3] motion-reduce:animate-none" />
        <div className="h-24 w-full animate-pulse rounded-lg bg-[#EDEBE3] motion-reduce:animate-none" />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <p className="text-[13.5px] text-[#5B6560]">{error}</p>
      </Card>
    );
  }

  if (blockedReason) {
    return (
      <Card>
        <p className="text-[13.5px] text-[#5B6560]">{blockedReason}</p>
      </Card>
    );
  }

  if (!week || week.days.every((d) => d.stops.length === 0)) {
    return (
      <Card>
        <p className="text-[13.5px] text-[#5B6560]">Nothing due this week that isn&apos;t already on your route.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {week.days
        .filter((d) => d.stops.length > 0)
        .map((day) => (
          <DayCard key={day.date} day={day} onUsed={() => removeDay(day.date)} />
        ))}
      {week.unroutable.length > 0 && <UnroutableCard entries={week.unroutable} />}
    </div>
  );
}

function DayCard({ day, onUsed }: { day: PlannedDay; onUsed: () => void }) {
  const label = dayLabel(day.date);
  const keyRef = useRef(newKey());
  const [phase, setPhase] = useState<"idle" | "busy" | "conflict" | "success" | "error">("idle");
  const [existingCount, setExistingCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function useThisDay(mode?: "replace" | "add") {
    setPhase("busy");
    setErrorMsg(null);
    try {
      const res = await apiFetch("/api/planner/use-day", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": keyRef.current },
        body: JSON.stringify({
          date: day.date,
          accountIds: day.stops.map((s) => s.accountId),
          directiveIds: day.stops.map((s) => s.directiveId).filter((id): id is string => Boolean(id)),
          mode,
        }),
      });
      const j = await res.json();
      if (!j.ok) {
        setPhase("error");
        setErrorMsg(j.error ?? "Couldn't use that day.");
        return;
      }
      if (j.conflict) {
        setExistingCount(j.existingCount ?? 0);
        setPhase("conflict");
        return;
      }
      setPhase("success");
      window.setTimeout(onUsed, 1100);
    } catch {
      setPhase("error");
      setErrorMsg("Couldn't reach the route.");
    }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className={eyebrowCls}>
            {label.weekday} {label.short}
          </div>
          <div className={`${displayFace} mt-0.5 text-[16px] font-semibold tracking-tight`}>
            {day.stops.length} stop{day.stops.length === 1 ? "" : "s"}
            {day.overnight ? ", overnight" : ""}
          </div>
        </div>
        <div className="text-right text-[12px] text-[#8A928C]">
          {day.driveMinutesTotal} min driving
          {!day.driveEstimateAvailable && <div>some legs estimated</div>}
        </div>
      </div>

      {day.warnings.length > 0 && (
        <div className="mb-3 text-[12.5px] leading-relaxed text-[#8A6D2F]">{day.warnings.join(". ")}.</div>
      )}

      <ol className="flex flex-col gap-3 border-t border-[#EEECE3] pt-3">
        {day.stops.map((s, i) => (
          <StopRow key={`${s.accountId}-${i}`} stop={s} />
        ))}
      </ol>

      <div className="mt-4 border-t border-[#EEECE3] pt-3">
        {phase === "success" ? (
          <SuccessNote title="On your route" detail={`${day.stops.length} stops, ${label.weekday} ${label.short}`} />
        ) : phase === "conflict" ? (
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] text-[#5B6560]">
              {existingCount} stop{existingCount === 1 ? "" : "s"} already on this day.
            </p>
            <div className="flex gap-2">
              <button type="button" className={`${ghostBtn} flex-1`} onClick={() => useThisDay("add")}>
                Add around them
              </button>
              <button type="button" className={`${primaryBtn} flex-1`} onClick={() => useThisDay("replace")}>
                Replace day
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <button type="button" className={primaryBtn} disabled={phase === "busy"} onClick={() => useThisDay()}>
              {phase === "busy" ? "Using this day..." : "Use this day"}
            </button>
            {phase === "error" && errorMsg && <p className="text-[12px] text-[#8A2E2E]">{errorMsg}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}

function StopRow({ stop }: { stop: PlannedStop }) {
  return (
    <li className="flex gap-3">
      <div className="w-14 shrink-0 pt-0.5 text-[12.5px] font-medium tabular-nums text-[#5B6560]">{fmtClock(stop.arrive)}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-[#14201B]">{stop.name}</div>
            <div className="text-[11.5px] text-[#8A928C]">{KIND_LABEL[stop.kind]}</div>
          </div>
          <a
            href={stop.mapsUrl}
            aria-label={`Open ${stop.name} in Maps`}
            className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-[#E2DFD5] bg-white text-[#5B6560] transition-transform active:scale-[0.97] motion-reduce:transition-none"
          >
            <Ico name="pin" size={15} />
          </a>
        </div>
        {stop.why && <p className="mt-1 text-[12.5px] leading-relaxed text-[#5B6560]">{stop.why}</p>}
        {stop.quote && <p className="mt-1 text-[12.5px] italic leading-relaxed text-[#8A928C]">&quot;{stop.quote}&quot;</p>}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-[#8A928C]">
          {stop.driveFromPrevMinutes !== null && (
            <span>
              {stop.driveFromPrevMinutes} min{stop.driveFromPrevMiles !== null ? ` · ${stop.driveFromPrevMiles} mi` : ""}
              {stop.driveEstimated ? " (estimated)" : ""}
            </span>
          )}
          {stop.hoursNote && <span>{stop.hoursNote}</span>}
        </div>
      </div>
    </li>
  );
}

function UnroutableCard({ entries }: { entries: UnroutableEntry[] }) {
  return (
    <Card>
      <div className={eyebrowCls}>Not routed this week</div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {entries.map((e) => (
          <li key={e.accountId} className="flex items-center justify-between gap-3 text-[13px]">
            <span className="text-[#14201B]">{e.name}</span>
            <span className="text-[#8A928C]">{REASON_LABEL[e.reason]}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
