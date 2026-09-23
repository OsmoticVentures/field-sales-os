"use client";

/**
 * The day's report and the week's report: a status line, each stop's toggles
 * and gist, HQ notes, mileage, and the published PDF. Ported from the
 * NutriBiotic OS's lib/report-review-ui.tsx, trimmed to what this feature
 * owns (see dal.ts's saveReportDraftPayload comment for what stayed behind:
 * route start/end override and field-note reclassification, both owned by
 * features not yet ported here).
 *
 * Every write goes through a route handler with an Idempotency-Key, never a
 * Server Action, per PORTING.md. Every fetch goes through apiFetch so it
 * carries the /nb basePath.
 */
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/core/api";
import { Ico, SuccessNote, Card, primaryBtn, ghostBtn, inputCls, eyebrowCls } from "../../../lib/core/ui";
import type { ReportDraft, ReportHqNote } from "../../../lib/features/reports/dal";
import { stopGist } from "../../../lib/features/reports/stop-gist";

const HQ_CATEGORIES = ["FORMULATION & PRODUCT", "DISCOUNTS & PRICING", "ENTERPRISE & HQ ACCESS", "COMPETITIVE INTEL", "OTHER"];

type StopEdit = { hidden: boolean; call_only: boolean; message_only: boolean };

/** A move-earlier/move-later chevron. Local to this feature: lib/core/ui.tsx's
 *  Ico set (shared, not edited by this port) has no chevron today. */
function Chevron({ dir }: { dir: "up" | "down" }) {
  return (
    <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === "up" ? "m3.6 10 4.4-4.4L12.4 10" : "m3.6 6 4.4 4.4L12.4 6"} />
    </svg>
  );
}

type Props = {
  today: string;
  initialDate: string;
  initialWeek: { start: string; end: string } | null;
  initialDaily: ReportDraft | null;
  initialDailyPreviewUrl: string | null;
  initialDailyArchivedUrl: string | null;
  initialWeekly: ReportDraft | null;
  initialWeeklyPreviewUrl: string | null;
  initialWeeklyArchivedUrl: string | null;
};

export function ReportsClient(props: Props) {
  const router = useRouter();
  const [date, setDate] = useState(props.initialDate);
  const [daily, setDaily] = useState(props.initialDaily);
  const [dailyPreviewUrl, setDailyPreviewUrl] = useState(props.initialDailyPreviewUrl);
  const [dailyArchivedUrl, setDailyArchivedUrl] = useState(props.initialDailyArchivedUrl);
  const [week, setWeek] = useState(props.initialWeek);
  const [weekly, setWeekly] = useState(props.initialWeekly);
  const [weeklyPreviewUrl, setWeeklyPreviewUrl] = useState(props.initialWeeklyPreviewUrl);
  const [weeklyArchivedUrl, setWeeklyArchivedUrl] = useState(props.initialWeeklyArchivedUrl);
  const [error, setError] = useState<string | null>(null);

  function onDateChange(next: string) {
    if (!next) return;
    setDate(next);
    router.push(`?date=${next}`);
    apiFetch(`/api/reports?date=${next}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.ok) return;
        setDaily(data.daily);
        setDailyPreviewUrl(data.dailyPreviewUrl);
        setDailyArchivedUrl(data.dailyArchivedUrl);
        setWeek(data.week);
        setWeekly(data.weekly);
        setWeeklyPreviewUrl(data.weeklyPreviewUrl);
        setWeeklyArchivedUrl(data.weeklyArchivedUrl);
      })
      .catch(() => setError("Could not load that day. Try again."));
  }

  async function refresh() {
    try {
      const res = await apiFetch(`/api/reports?date=${date}`);
      const data = await res.json();
      if (!data.ok) throw new Error();
      setDaily(data.daily);
      setDailyPreviewUrl(data.dailyPreviewUrl);
      setDailyArchivedUrl(data.dailyArchivedUrl);
      setWeekly(data.weekly);
      setWeeklyPreviewUrl(data.weeklyPreviewUrl);
      setWeeklyArchivedUrl(data.weeklyArchivedUrl);
    } catch {
      setError("Could not refresh. Try again.");
    }
  }

  return (
    <>
      <div className="mb-5 flex items-center gap-2">
        <label htmlFor="report-date" className={eyebrowCls}>
          Reviewing
        </label>
        <input
          id="report-date"
          type="date"
          value={date}
          max={props.today}
          onChange={(e) => onDateChange(e.target.value)}
          className={`${inputCls} w-auto tabular-nums`}
        />
        {date !== props.today && (
          <button
            type="button"
            onClick={() => onDateChange(props.today)}
            className="text-[13px] text-[#2C6A46] underline decoration-[#2C6A46]/40 underline-offset-2 hover:decoration-[#2C6A46]"
          >
            Back to today
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4">
          <p className="text-[13px] text-[#8A2E2E]">{error}</p>
        </div>
      )}

      <DailyReport
        date={date}
        draft={daily}
        previewUrl={dailyPreviewUrl}
        archivedUrl={dailyArchivedUrl}
        onChanged={refresh}
        onError={setError}
      />

      {weekly?.payload ? (
        <WeeklyReport draft={weekly} previewUrl={weeklyPreviewUrl} archivedUrl={weeklyArchivedUrl} />
      ) : weeklyArchivedUrl && week ? (
        <Card className="mb-8">
          <h2 className="mb-3 text-[19px] font-semibold tracking-tight">
            Week of {week.start} to {week.end}
          </h2>
          <p className="mb-3 text-[13.5px] text-[#5B6560]">Published, no draft on file.</p>
          <a href={weeklyArchivedUrl} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1.5 ${primaryBtn}`}>
            <Ico name="external" size={13} />
            Open the published PDF
          </a>
        </Card>
      ) : week ? (
        <p className="mb-8 text-[12.5px] text-[#8A928C]">No weekly report built for {week.start} to {week.end}.</p>
      ) : null}
    </>
  );
}

function DailyReport({
  date,
  draft,
  previewUrl,
  archivedUrl,
  onChanged,
  onError,
}: {
  date: string;
  draft: ReportDraft | null;
  previewUrl: string | null;
  archivedUrl: string | null;
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState<string | null>(null);
  const payload = draft?.payload ?? null;
  const stops = useMemo(() => payload?.stops ?? [], [payload]);

  const [hqNotes, setHqNotes] = useState<ReportHqNote[]>(payload?.hq_notes ?? []);
  const [miles, setMiles] = useState<string>(payload?.miles_override != null ? String(payload.miles_override) : "");
  const [stopEdits, setStopEdits] = useState<Record<string, StopEdit>>({});
  const [order, setOrder] = useState<number[]>([]);

  useEffect(() => {
    setHqNotes(payload?.hq_notes ?? []);
    setMiles(payload?.miles_override != null ? String(payload.miles_override) : "");
    setStopEdits(
      Object.fromEntries(
        stops.map((s) => [
          String(s.n),
          { hidden: Boolean(s.hidden), call_only: Boolean(s.is_call_only), message_only: Boolean(s.is_message_only) },
        ]),
      ),
    );
    setOrder(stops.map((s) => s.n ?? 0));
  }, [payload, stops]);

  const orderedStops = order.map((n) => stops.find((s) => s.n === n)).filter((s): s is NonNullable<typeof s> => Boolean(s));

  function moveStop(n: number, dir: -1 | 1) {
    setOrder((prev) => {
      const i = prev.indexOf(n);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function withKey<T>(fn: (key: string) => Promise<T>): Promise<T> {
    const key = crypto.randomUUID();
    return fn(key);
  }

  function rebuild() {
    onError(null);
    startTransition(async () => {
      try {
        await withKey((key) =>
          apiFetch("/api/reports/rebuild", {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": key },
            body: JSON.stringify({ date }),
          }).then((r) => r.json()),
        );
        await onChanged();
      } catch {
        onError("Could not ask for a rebuild. Try again.");
      }
    });
  }

  function render() {
    onError(null);
    startTransition(async () => {
      try {
        await withKey((key) =>
          apiFetch("/api/reports/render", {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": key },
            body: JSON.stringify({ date, kind: "daily" }),
          }).then((r) => r.json()),
        );
        await onChanged();
      } catch {
        onError("Could not start the render. Try again.");
      }
    });
  }

  function save() {
    onError(null);
    startTransition(async () => {
      try {
        const res = await withKey((key) =>
          apiFetch("/api/reports/save", {
            method: "POST",
            headers: { "content-type": "application/json", "idempotency-key": key },
            body: JSON.stringify({
              date,
              edits: { hqNotes, miles: miles.trim() === "" ? null : Number(miles), stops: stopEdits, order },
            }),
          }).then((r) => r.json()),
        );
        if (!res.ok) throw new Error();
        setSaved("Saved. The preview is re-rendering.");
        await onChanged();
      } catch {
        onError("Could not save your edits. Try again.");
      }
    });
  }

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), 1200);
    return () => clearTimeout(t);
  }, [saved]);

  const shownUrl = draft?.status === "published" && archivedUrl ? archivedUrl : previewUrl;
  const locked = pending;
  const statusLine = draft?.rebuild_requested
    ? "Rebuilding from today's data"
    : draft?.dirty
      ? "Re-rendering from your edits"
      : draft?.status === "published"
        ? "Published. Edit it any time."
        : "Building";

  return (
    <Card className="mb-8">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[19px] font-semibold tracking-tight">The day&rsquo;s report</h2>
        <span className="text-[12.5px] text-[#8A928C]">{statusLine}</span>
      </div>

      {!payload ? (
        archivedUrl ? (
          <div>
            <p className="mb-3 text-[13.5px] text-[#5B6560]">No draft on file, but a report was published that day.</p>
            <a href={archivedUrl} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1.5 ${primaryBtn}`}>
              <Ico name="external" size={13} />
              Open the published PDF
            </a>
          </div>
        ) : (
          <div>
            <p className="mb-3 text-[13.5px] text-[#5B6560]">Nothing built for this day yet.</p>
            <button type="button" onClick={rebuild} disabled={pending} className={primaryBtn}>
              {pending ? "Asking" : "Build this day's report"}
            </button>
          </div>
        )
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            {shownUrl ? (
              <a href={shownUrl} target="_blank" rel="noreferrer" className={`inline-flex items-center gap-1.5 ${primaryBtn}`}>
                <Ico name="external" size={13} />
                {shownUrl === archivedUrl ? "Open the published PDF" : "Open the latest render"}
              </a>
            ) : (
              <button type="button" onClick={render} disabled={pending} className={`inline-flex items-center gap-1.5 ${primaryBtn}`}>
                {pending ? "Rendering" : "Render preview"}
              </button>
            )}
            <button type="button" onClick={rebuild} disabled={locked} className={ghostBtn}>
              Rebuild from today&rsquo;s data
            </button>
            {draft?.dirty && <span className="text-[12px] text-[#8A6D2F]">The PDF is behind your edits.</span>}
          </div>

          {shownUrl && !draft?.dirty && (
            <div className="mb-5 overflow-hidden rounded-lg border border-[#E2DFD5]">
              <iframe src={shownUrl} title={`Report, ${date}`} className="h-[70vh] w-full" />
            </div>
          )}

          <div className="mb-5">
            <div className={`mb-2 ${eyebrowCls}`}>
              Stops · {stops.filter((s) => !stopEdits[String(s.n)]?.hidden).length} of {stops.length}
            </div>
            {orderedStops.length === 0 ? (
              <p className="text-[13px] text-[#8A928C]">No stops on this day.</p>
            ) : (
              <ul className="divide-y divide-[#EDEBE3] overflow-hidden rounded-lg border border-[#E2DFD5]">
                {orderedStops.map((s, i) => {
                  const key = String(s.n);
                  const n = s.n ?? 0;
                  const e = stopEdits[key] ?? { hidden: false, call_only: false, message_only: false };
                  const set = (patch: Partial<StopEdit>) => setStopEdits((prev) => ({ ...prev, [key]: { ...e, ...patch } }));
                  const gist = stopGist(s);
                  return (
                    <li key={key} className={`flex flex-wrap items-center gap-2 px-3 py-2.5 ${e.hidden ? "opacity-45" : ""}`}>
                      <div className="flex shrink-0 gap-1">
                        <button
                          type="button"
                          onClick={() => moveStop(n, -1)}
                          disabled={locked || i === 0}
                          aria-label={`Move ${s.name} earlier`}
                          className="flex h-11 w-11 items-center justify-center rounded-md border border-[#E2DFD5] bg-white text-[#3D4A44] transition-colors hover:bg-[#FAF9F5] disabled:opacity-30"
                        >
                          <Chevron dir="up" />
                        </button>
                        <button
                          type="button"
                          onClick={() => moveStop(n, 1)}
                          disabled={locked || i === orderedStops.length - 1}
                          aria-label={`Move ${s.name} later`}
                          className="flex h-11 w-11 items-center justify-center rounded-md border border-[#E2DFD5] bg-white text-[#3D4A44] transition-colors hover:bg-[#FAF9F5] disabled:opacity-30"
                        >
                          <Chevron dir="down" />
                        </button>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px]">
                          {s.name}
                          {s.city && <span className="text-[#8A928C]"> · {s.city}</span>}
                        </div>
                        {gist && <div className="mt-0.5 truncate text-[12px] text-[#8A928C]">{gist}</div>}
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                        <Toggle on={e.call_only} onClick={() => set({ call_only: !e.call_only })} disabled={locked}>
                          Call only
                        </Toggle>
                        <Toggle on={e.hidden} onClick={() => set({ hidden: !e.hidden })} disabled={locked} danger>
                          Hide
                        </Toggle>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="mb-5 flex flex-wrap items-center gap-2">
            <label className={eyebrowCls} htmlFor="miles">
              Miles
            </label>
            <input
              id="miles"
              inputMode="numeric"
              value={miles}
              disabled={locked}
              onChange={(ev) => setMiles(ev.target.value.replace(/[^\d]/g, ""))}
              placeholder={payload.miles != null ? String(payload.miles) : ""}
              className={`${inputCls} w-24 tabular-nums`}
            />
            <span className="text-[12px] text-[#8A928C]">Blank recomputes it from the stops above.</span>
          </div>

          <div className="mb-5">
            <div className={`mb-2 ${eyebrowCls}`}>Notes to HQ</div>
            <div className="flex flex-col gap-2">
              {hqNotes.map((n, i) => (
                <div key={i} className="flex flex-wrap items-start gap-2">
                  <select
                    value={n.category}
                    disabled={locked}
                    onChange={(ev) => setHqNotes((prev) => prev.map((x, j) => (j === i ? { ...x, category: ev.target.value } : x)))}
                    className={`${inputCls} w-auto`}
                  >
                    {HQ_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <textarea
                    value={n.text}
                    disabled={locked}
                    rows={2}
                    onChange={(ev) => setHqNotes((prev) => prev.map((x, j) => (j === i ? { ...x, text: ev.target.value } : x)))}
                    className={`min-w-[220px] flex-1 leading-relaxed ${inputCls}`}
                  />
                  <button
                    type="button"
                    onClick={() => setHqNotes((prev) => prev.filter((_, j) => j !== i))}
                    disabled={locked}
                    aria-label="Remove note"
                    className="flex h-11 w-11 items-center justify-center rounded-md border border-[#E2DFD5] text-[#5B6560] transition-colors hover:bg-[#FAF9F5] disabled:opacity-40"
                  >
                    <Ico name="close" size={12} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setHqNotes((prev) => [...prev, { category: "OTHER", text: "", source: "Juan" }])}
                disabled={locked}
                className={`self-start ${ghostBtn}`}
              >
                Add a note
              </button>
            </div>
          </div>

          {saved && (
            <div className="mb-4">
              <SuccessNote title={saved} />
            </div>
          )}

          <div className="flex flex-wrap gap-2 border-t border-[#EDEBE3] pt-4">
            <button type="button" onClick={save} disabled={locked} className={primaryBtn}>
              {pending ? "Saving" : "Save and republish"}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

function Toggle({
  on,
  onClick,
  disabled,
  danger,
  children,
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={on}
      className={`h-9 rounded-md border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-40 ${
        on
          ? danger
            ? "border-[#8A2E2E] bg-[#8A2E2E] text-[#F7F6F1]"
            : "border-[#14201B] bg-[#14201B] text-[#F7F6F1]"
          : "border-[#E2DFD5] bg-white text-[#5B6560] hover:bg-[#FAF9F5]"
      }`}
    >
      {children}
    </button>
  );
}

function WeeklyReport({
  draft,
  previewUrl,
  archivedUrl,
}: {
  draft: ReportDraft;
  previewUrl: string | null;
  archivedUrl: string | null;
}) {
  const payload = draft.payload;
  if (!payload) return null;
  const shownUrl = draft.status === "published" && archivedUrl ? archivedUrl : previewUrl;
  const totals = payload.totals ?? {};
  const rangeLabel = payload.range_label ?? draft.report_date;
  const statusLine = draft.rebuild_requested
    ? "Rebuilding"
    : draft.dirty
      ? "Re-rendering from your edits"
      : draft.status === "published"
        ? "Published. Edit it any time."
        : "Building";

  const tiles: Array<[keyof typeof totals, string]> = [
    ["touchpoints", "Touchpoints"],
    ["visits", "Visits"],
    ["calls", "Calls"],
    ["miles", "Miles"],
    ["new_accounts", "New accounts"],
    ["accounts_closed", "Closed"],
  ];

  return (
    <Card className="mb-8">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[19px] font-semibold tracking-tight">This week&rsquo;s report · {rangeLabel}</h2>
        <span className="text-[12.5px] text-[#8A928C]">{statusLine}</span>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([key, label]) =>
          totals[key] != null ? (
            <div key={key} className="rounded-lg border border-[#E2DFD5] p-3 text-center">
              <div className="text-[18px] font-semibold tabular-nums leading-none">{totals[key]}</div>
              <div className="mt-1 text-[10.5px] leading-snug text-[#5B6560]">{label}</div>
            </div>
          ) : null,
        )}
      </div>

      {shownUrl && (
        <a href={shownUrl} target="_blank" rel="noreferrer" className={`mb-5 inline-flex items-center gap-1.5 ${primaryBtn}`}>
          <Ico name="external" size={13} />
          {shownUrl === archivedUrl ? "Open the published PDF" : "Open the latest render"}
        </a>
      )}

      {shownUrl && !draft.dirty && (
        <div className="overflow-hidden rounded-lg border border-[#E2DFD5]">
          <iframe src={shownUrl} title={`Weekly report, ${rangeLabel}`} className="h-[70vh] w-full" />
        </div>
      )}
    </Card>
  );
}
