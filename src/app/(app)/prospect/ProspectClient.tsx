"use client";

/**
 * Prospect. A scored call list you work down with one thumb: tap a row,
 * the account opens below with its contacts, opening hours, and Angle
 * panel, call with one tap, mark it done, move on.
 *
 * Ported from the NutriBiotic OS's sdr-ui.tsx
 * (portfolio/src/app/nutribiotic/lib/sdr-ui.tsx). Every write goes through
 * an /api/prospect/* route handler with an Idempotency-Key, never a Server
 * Action (PORTING.md).
 *
 * NOT PORTED IN THIS PASS (see this agent's handback for why): the shared
 * five-section filter bar and chains/practices/prospects hide toggles
 * (nb_ui_prefs, also read by Route Planner's map), "add to route"
 * (nb_ui_prefs.route_draft, Route Planner's own draft), and the inline
 * call-logging capture box (the touchpoint pipeline, shared with Visit
 * Logger, not yet in this repo). Marking a call done stands alone, the same
 * "done by hand, no logged call" case the source app already supports.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../../lib/core/api";
import { Card, Ico, SuccessNote, ghostBtn, inputCls, primaryBtn } from "../../../lib/core/ui";
import { FindContacts } from "../../../lib/features/enrich/ui";
import { hoursStatus, laTodayKey, type BusinessHours } from "../../../lib/features/prospect/hours";
import { HUBSPOT_COMPANY_URL, daysAgo, dueInDays, exactDaysAgo, fullAddress, googleMapsUrl, money } from "../../../lib/features/prospect/format";

// ---------------------------------------------------------------------------
// Types (mirror the /api/prospect/schedule and /api/prospect/account shapes)
// ---------------------------------------------------------------------------

type SdrPriority = "low" | "mid" | "high";

type ScheduleItem = {
  id: string;
  account_id: string | null;
  prospect_name: string | null;
  prospect_phone: string | null;
  kind: "call" | "visit";
  scheduled_date: string;
  status: "pending" | "done" | "skipped";
  priority: SdrPriority | null;
  rescheduled_at: string | null;
  displayName: string;
  displayPhone: string | null;
  area: string | null;
  businessHours: BusinessHours | null;
  priorityScore: number | null;
  priorityReason: string | null;
  priorityBand: "now" | "soon" | "later" | "unscored" | null;
};

type AreaGroup = { id: string; label: string; color: string; prospects: number };

type RankedAccount = { id: string; name: string; area: string | null; score: number | null; reason: string; band: string };

type AccountPanelData = {
  id: string;
  name: string;
  channel: string;
  area: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
  leadStatus: string | null;
  potentialJuan: string | null;
  readiness: "urgent" | "hot" | "normal" | "cold" | null;
  quirks: string | null;
  currentState: string | null;
  futureState: string | null;
  impact: string | null;
  lastOrderAt: string | null;
  lifetimeRevenue: number | null;
  expectedReorderAt: string | null;
  purchases: { orderCount: number; topItems: { name: string; qty: number; revenueCents: number; last3Qty: number }[]; smallItemNames: string[] } | null;
  businessHours: BusinessHours | null;
  hubspotCompanyId: string | null;
  contacts: { id: string; name: string; title: string | null; phone: string | null; email: string | null; isDecisionMaker: boolean }[];
  activities: { at: string; kind: string; detail: string | null }[];
};

type SearchHit = { accountId: string; accountName: string; city: string | null; phone: string | null; area: string | null; contactName: string | null; contactTitle: string | null };

// ---------------------------------------------------------------------------
// Shared style tokens (16px text / 44px targets, per PORTING.md)
// ---------------------------------------------------------------------------

// primaryBtn, ghostBtn, inputCls come from lib/core/ui (PORTING.md); this
// feature only extends them for the two shapes core doesn't cover.
const callBtn =
  "inline-flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-[#8A2E2E] px-4 text-[14px] font-medium text-white transition-transform active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100";
const iconBtn =
  "flex h-11 w-11 shrink-0 items-center justify-center rounded-md border text-[#5B6560] transition-transform active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100";

function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function dayLabel(iso: string, todayIso: string): string {
  const diffDays = Math.round((new Date(`${iso}T00:00:00`).getTime() - new Date(`${todayIso}T00:00:00`).getTime()) / 86_400_000);
  const d = new Date(`${iso}T00:00:00`);
  const md = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (diffDays === 0) return `Today, ${md}`;
  if (diffDays === 1) return `Tomorrow, ${md}`;
  return `${d.toLocaleDateString("en-US", { weekday: "short" })}, ${md}`;
}

function quickDayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getDate()}`;
}

function nextDays(todayIso: string, count: number): string[] {
  const out: string[] = [];
  for (let n = 1; out.length < count; n++) out.push(addDaysIso(todayIso, n));
  return out;
}

/** Monday of the work week that `iso` falls in, same YYYY-MM-DD shape. */
function mondayOfIso(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay(); // 0 Sun .. 6 Sat
  const sinceMonday = (dow + 6) % 7;
  date.setUTCDate(date.getUTCDate() - sinceMonday);
  return date.toISOString().slice(0, 10);
}

/** "Oct 15-19", the Monday-Friday span of the work week `n` weeks after
 *  today's own work week, so "push back" always lands on a real calendar
 *  range instead of a relative "1 week" label. */
function pushBackWeeks(todayIso: string, count: number): { iso: string; label: string }[] {
  const thisMonday = mondayOfIso(todayIso);
  const out: { iso: string; label: string }[] = [];
  for (let n = 1; n <= count; n++) {
    const mon = addDaysIso(thisMonday, n * 7);
    const fri = addDaysIso(mon, 4);
    const monD = new Date(`${mon}T00:00:00`);
    const friD = new Date(`${fri}T00:00:00`);
    const monMonth = monD.toLocaleDateString("en-US", { month: "short" });
    const friMonth = friD.toLocaleDateString("en-US", { month: "short" });
    const label = monMonth === friMonth ? `${monMonth} ${monD.getDate()}-${friD.getDate()}` : `${monMonth} ${monD.getDate()}-${friMonth} ${friD.getDate()}`;
    out.push({ iso: mon, label });
  }
  return out;
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2, 10);
}

/** Plain refresh glyph for "Enrich further" (core ui's "wand" icon is a
 *  sparkle mark, banned agency-wide; feature-local since lib/core is out of
 *  scope for this pass). Matches Ico's own stroke weight and viewBox. */
function RefreshIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <path d="M12.8 8.4A4.8 4.8 0 1 1 11.3 4.7" />
      <path d="M12.8 3.4v3.4h-3.4" />
    </svg>
  );
}

function OpenBadge({ businessHours }: { businessHours: BusinessHours | null | undefined }) {
  const status = hoursStatus(businessHours);
  if (!status) return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12px] font-medium ${status.open ? "bg-[#E3EFE6] text-[#3D6B4A]" : "bg-[#ECEAE1] text-[#8A928C]"}`}>
      <span className={`h-[6px] w-[6px] rounded-full ${status.open ? "bg-[#3D6B4A]" : "bg-[#B7ACA0]"}`} />
      {status.label}
    </span>
  );
}

function Fact({ label, value, href }: { label: string; value: string | null; href?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-1.5 text-[14px]">
      <span className="text-[#8A928C]">{label}</span>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-[#3D6B4A] hover:underline">
          {value}
        </a>
      ) : (
        <span className="text-[#3D4A44]">{value}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function GlobalSearch({ todayIso, onView, onAdded }: { todayIso: string; onView: (hit: SearchHit) => void; onAdded: (item: ScheduleItem) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [pending, startTransition] = useTransition();
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [dateValue, setDateValue] = useState(todayIso);

  function search(q: string) {
    setQuery(q);
    setAddingFor(null);
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    startTransition(async () => {
      const res = await apiFetch(`/api/prospect/search?q=${encodeURIComponent(q)}`);
      const j = await res.json();
      setHits(j.ok ? j.hits : []);
    });
  }

  function confirmAdd(hit: SearchHit) {
    startTransition(async () => {
      const res = await apiFetch("/api/prospect/schedule", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": newId() },
        body: JSON.stringify({ account_id: hit.accountId, kind: "call", scheduled_date: dateValue }),
      });
      const j = await res.json();
      if (!j.ok) return;
      onAdded({
        ...j.result,
        displayName: hit.accountName,
        displayPhone: hit.phone,
        area: hit.area,
        businessHours: null,
        priorityScore: null,
        priorityReason: null,
        priorityBand: null,
      });
      setAddingFor(null);
      setQuery("");
      setHits([]);
    });
  }

  return (
    <div className="relative">
      <div className="relative">
        <input value={query} onChange={(e) => search(e.target.value)} placeholder="Search your accounts and contacts" className={`${inputCls} pl-10`} />
        <div className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[#8A928C]">
          <Ico name="search" size={15} />
        </div>
      </div>
      {query.trim().length >= 2 && (
        <div className="absolute z-20 mt-1.5 w-full rounded-md border border-[#E2DFD5] bg-white shadow-sm">
          {pending && hits.length === 0 ? (
            <div className="px-3 py-3 text-[14px] text-[#8A928C]">Searching</div>
          ) : hits.length === 0 ? (
            <div className="px-3 py-3 text-[14px] text-[#8A928C]">No match in your book.</div>
          ) : (
            hits.map((hit) => (
              <div key={hit.accountId} className="flex flex-wrap items-center justify-between gap-2 border-b border-[#F0EEE6] p-2.5 last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium text-[#14201B]">
                    {hit.contactName ? `${hit.contactName}${hit.contactTitle ? `, ${hit.contactTitle}` : ""}, ${hit.accountName}` : hit.accountName}
                  </div>
                  <div className="text-[12.5px] text-[#8A928C]">{[hit.city, hit.phone].filter(Boolean).join(", ") || " "}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {addingFor === hit.accountId ? (
                    <>
                      <input type="date" value={dateValue} onChange={(e) => setDateValue(e.target.value)} className={`${inputCls} w-[150px]`} />
                      <button onClick={() => confirmAdd(hit)} disabled={pending} className={primaryBtn}>
                        Add
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => { setAddingFor(hit.accountId); setDateValue(todayIso); }} className={ghostBtn}>
                        Add to day
                      </button>
                      <button onClick={() => onView(hit)} className={ghostBtn}>
                        View
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add to a day
// ---------------------------------------------------------------------------

function AddToDayForm({ date, onAdded }: { date: string; onAdded: (item: ScheduleItem) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"account" | "prospect">("account");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ id: string; name: string; city: string | null; phone: string | null; area: string | null }[]>([]);
  const [picked, setPicked] = useState<{ id: string; name: string; city: string | null; phone: string | null; area: string | null } | null>(null);
  const [prospectName, setProspectName] = useState("");
  const [prospectPhone, setProspectPhone] = useState("");
  const [pending, startTransition] = useTransition();

  function search(q: string) {
    setQuery(q);
    setPicked(null);
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    startTransition(async () => {
      const res = await apiFetch(`/api/prospect/search?q=${encodeURIComponent(q)}`);
      const j = await res.json();
      setHits(j.ok ? j.hits.map((h: SearchHit) => ({ id: h.accountId, name: h.accountName, city: h.city, phone: h.phone, area: h.area })) : []);
    });
  }

  function reset() {
    setQuery("");
    setHits([]);
    setPicked(null);
    setProspectName("");
    setProspectPhone("");
    setOpen(false);
  }

  function submit() {
    if (mode === "account" && !picked) return;
    if (mode === "prospect" && !prospectName.trim()) return;
    startTransition(async () => {
      const res = await apiFetch("/api/prospect/schedule", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": newId() },
        body: JSON.stringify({
          account_id: mode === "account" ? picked!.id : null,
          prospect_name: mode === "prospect" ? prospectName.trim() : null,
          prospect_phone: mode === "prospect" ? prospectPhone.trim() || null : null,
          kind: "call",
          scheduled_date: date,
        }),
      });
      const j = await res.json();
      if (!j.ok) return;
      onAdded({
        ...j.result,
        displayName: mode === "account" ? picked!.name : prospectName.trim(),
        displayPhone: mode === "account" ? picked!.phone : prospectPhone.trim() || null,
        area: mode === "account" ? picked!.area : null,
        businessHours: null,
        priorityScore: null,
        priorityReason: null,
        priorityBand: null,
      });
      reset();
    });
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[#D8D4C8] text-[13.5px] font-medium text-[#8A928C] transition-colors hover:border-[#B8B3A4] hover:text-[#5B6560]">
        <Ico name="plus" size={13} />
        Add to this day
      </button>
    );
  }

  return (
    <div className="rounded-md border border-[#E2DFD5] bg-[#FAF9F5] p-3">
      <div className="mb-2 flex gap-1.5">
        <button onClick={() => setMode("account")} className={`min-h-11 rounded-md px-2.5 py-2 text-[13px] font-medium ${mode === "account" ? "bg-[#14201B] text-[#F7F6F1]" : "bg-[#ECEAE1] text-[#5B6560]"}`}>
          Existing account
        </button>
        <button onClick={() => setMode("prospect")} className={`min-h-11 rounded-md px-2.5 py-2 text-[13px] font-medium ${mode === "prospect" ? "bg-[#14201B] text-[#F7F6F1]" : "bg-[#ECEAE1] text-[#5B6560]"}`}>
          New prospect
        </button>
      </div>

      {mode === "account" ? (
        <div className="relative">
          <input value={picked ? picked.name : query} onChange={(e) => search(e.target.value)} placeholder="Search your accounts by name" className={inputCls} />
          {hits.length > 0 && !picked && (
            <div className="absolute z-10 mt-1 w-full rounded-md border border-[#E2DFD5] bg-white shadow-sm">
              {hits.map((h) => (
                <button key={h.id} onClick={() => { setPicked(h); setHits([]); }} className="block min-h-[44px] w-full px-3 text-left text-[14px] hover:bg-[#F7F6F1]">
                  {h.name}
                  {h.city ? <span className="text-[#8A928C]"> , {h.city}</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input value={prospectName} onChange={(e) => setProspectName(e.target.value)} placeholder="Business or contact name" className={inputCls} />
          <input value={prospectPhone} onChange={(e) => setProspectPhone(e.target.value)} placeholder="Phone" className={`${inputCls} sm:w-40`} />
        </div>
      )}

      <div className="mt-2.5 flex justify-end gap-2">
        <button onClick={reset} className={ghostBtn}>
          Cancel
        </button>
        <button onClick={submit} disabled={pending || (mode === "account" ? !picked : !prospectName.trim())} className={primaryBtn}>
          {pending ? "Adding" : "Add"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

const PRIORITY_CHIP: Record<"low" | "mid" | "high", string> = {
  low: "bg-[#ECEAE1] text-[#8A928C]",
  mid: "bg-[#E7EDE4] text-[#3D6B4A]",
  high: "bg-[#F3E3C6] text-[#8A6D2F]",
};

function ScheduleRow({
  item, active, onSelect, onDone, onReschedule, todayIso, statusError, showSuccess,
}: {
  item: ScheduleItem;
  active: boolean;
  onSelect: () => void;
  onDone: () => void;
  onReschedule: (date: string) => void;
  todayIso: string;
  statusError?: string;
  showSuccess?: boolean;
}) {
  const done = item.status === "done";
  const skipped = item.status === "skipped";
  const [moving, setMoving] = useState(false);

  if (showSuccess) {
    return (
      <li className={`rounded-md border p-2.5 ${active ? "border-[#14201B] bg-[#FAF9F5]" : "border-[#E2DFD5]"}`}>
        <SuccessNote title="Done" />
      </li>
    );
  }

  return (
    <li className={`flex flex-col gap-1.5 rounded-md border p-2.5 ${active ? "border-[#14201B] bg-[#FAF9F5]" : "border-[#E2DFD5]"} ${done ? "opacity-60" : ""} ${skipped ? "opacity-40" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <button onClick={onSelect} className="min-w-[150px] flex-1 text-left">
          <div className="flex items-baseline gap-1.5">
            {item.priorityScore !== null && (
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${item.priorityBand === "now" ? "bg-[#F3E3C6] text-[#8A6D2F]" : "bg-[#ECEAE1] text-[#5B6560]"}`}>
                {item.priorityScore}
              </span>
            )}
            <div className="line-clamp-2 min-w-0 text-[14.5px] leading-snug font-medium break-words text-[#14201B]">{item.displayName}</div>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] tracking-[0.06em] text-[#8A928C] uppercase">
            <span>{item.kind}</span>
            {item.priority && <span className={`rounded px-1 py-0.5 text-[10.5px] font-medium ${PRIORITY_CHIP[item.priority]}`}>{item.priority}</span>}
            {item.status !== "pending" && <span>, {item.status}</span>}
          </div>
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {item.displayPhone && (
            <a href={`tel:${item.displayPhone.replace(/[^0-9+]/g, "")}`} className={`${iconBtn} border-[#8A2E2E] bg-[#8A2E2E] text-white`} title={`Call ${item.displayPhone}`}>
              <Ico name="phone" size={15} />
            </a>
          )}
          {!done && !skipped && (
            <button onClick={() => setMoving((v) => !v)} title="Move to another day" className={`${iconBtn} ${moving ? "border-[#14201B]" : "border-[#E2DFD5]"}`}>
              <Ico name="clock" size={15} />
            </button>
          )}
          {!done && !skipped && (
            <button onClick={onDone} title="Mark done" className={`${iconBtn} border-[#E2DFD5]`}>
              <Ico name="check" size={15} />
            </button>
          )}
        </div>
      </div>

      {(item.businessHours || item.priorityReason) && (
        <button onClick={onSelect} className="flex min-w-0 items-center gap-1.5 text-left">
          {item.businessHours && <OpenBadge businessHours={item.businessHours} />}
          {item.priorityReason && (
            <span className="min-w-0 truncate text-[12px] leading-snug text-[#8A928C]" title={item.priorityReason}>
              {item.priorityReason}
            </span>
          )}
        </button>
      )}

      {statusError && (
        <div className="flex items-center gap-1.5 text-[12px] text-[#8A6D2F]">
          <Ico name="alert" size={12} />
          <span>{statusError}</span>
        </div>
      )}

      {moving && (
        <div className="flex w-full flex-col gap-1.5 border-t border-[#EFEDE5] pt-2">
          <div className="grid grid-cols-4 gap-1">
            {nextDays(todayIso, 4).map((iso, i) => (
              <button key={iso} type="button" onClick={() => { setMoving(false); onReschedule(iso); }} className="min-h-11 rounded-md border border-[#E2DFD5] bg-white px-1.5 text-[12px] font-medium text-[#3D4A44] hover:bg-[#FAF9F5]">
                {i === 0 ? "Tomorrow" : quickDayLabel(iso)}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-3 gap-1">
            {pushBackWeeks(todayIso, 3).map((w) => (
              <button key={w.iso} type="button" onClick={() => { setMoving(false); onReschedule(w.iso); }} className="min-h-11 rounded-md border border-[#E2DFD5] bg-white px-1.5 text-[12px] font-medium text-[#3D4A44] hover:bg-[#FAF9F5]">
                {w.label}
              </button>
            ))}
          </div>
          <input
            type="date"
            defaultValue={item.scheduled_date}
            onChange={(e) => {
              const v = e.target.value;
              if (!v || v === item.scheduled_date) return;
              setMoving(false);
              onReschedule(v);
            }}
            className={inputCls}
          />
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Account panel: contacts, hours, the Angle, purchases
// ---------------------------------------------------------------------------

const SDR_POTENTIAL_LETTERS = ["A", "B", "C", "D", "E"] as const;

function PotentialGradeInline({ accountId, value: initial }: { accountId: string; value: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[11.5px] tracking-[0.06em] text-[#8A928C] uppercase">Potential</span>
        <div className="flex flex-wrap gap-1">
          {SDR_POTENTIAL_LETTERS.map((t) => {
            const active = value === t;
            return (
              <button
                key={t}
                type="button"
                disabled={pending}
                onClick={() => {
                  const prev = value;
                  const next = active ? null : t;
                  setValue(next);
                  setError(null);
                  startTransition(async () => {
                    try {
                      const res = await apiFetch("/api/prospect/account-fact", {
                        method: "POST",
                        headers: { "content-type": "application/json", "Idempotency-Key": newId() },
                        body: JSON.stringify({ account_id: accountId, field: "potential_juan", value: next }),
                      });
                      const j = await res.json();
                      if (!j.ok) throw new Error();
                    } catch {
                      setValue(prev);
                      setError("Couldn't save. Try again.");
                    }
                  });
                }}
                className={`h-11 w-11 rounded text-[12px] font-semibold transition-colors ${active ? "bg-[#14201B] text-[#F7F6F1]" : "bg-[#ECEAE1] text-[#3D4A44] hover:bg-[#E2DFD5]"}`}
              >
                {t}
              </button>
            );
          })}
        </div>
      </div>
      {error && (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-[#8A6D2F]">
          <Ico name="alert" size={12} />
          {error}
        </span>
      )}
    </div>
  );
}

function PhoneEditable({ accountId, phone }: { accountId: string; phone: string | null }) {
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(phone);
  const [value, setValue] = useState(phone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="+13105551234" className={`${inputCls} w-[170px]`} />
          <button
            type="button"
            disabled={pending || !value.trim()}
            onClick={() => {
              const next = value.trim();
              startTransition(async () => {
                try {
                  const res = await apiFetch("/api/prospect/account-fact", {
                    method: "POST",
                    headers: { "content-type": "application/json", "Idempotency-Key": newId() },
                    body: JSON.stringify({ account_id: accountId, field: "phone", value: next }),
                  });
                  const j = await res.json();
                  if (!j.ok) throw new Error();
                  setSaved(next);
                  setEditing(false);
                  setError(null);
                } catch {
                  setError("Couldn't save. Try again.");
                }
              });
            }}
            className={primaryBtn}
          >
            {pending ? "Saving" : "Save"}
          </button>
          <button type="button" onClick={() => { setEditing(false); setError(null); }} className={ghostBtn}>
            Cancel
          </button>
        </div>
        {error && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-[#8A6D2F]">
            <Ico name="alert" size={12} />
            {error}
          </span>
        )}
      </div>
    );
  }
  return (
    <button type="button" onClick={() => { setValue(saved ?? ""); setEditing(true); }} title="Correct this number" className="flex min-h-11 items-center gap-1.5 text-[14.5px] font-medium text-[#3D4A44] hover:text-[#14201B]">
      {saved}
      <Ico name="edit" size={13} />
    </button>
  );
}

function AccountPanel({ item, areas, onDone, showSuccess }: { item: ScheduleItem; areas: AreaGroup[]; onDone: () => void; showSuccess?: boolean }) {
  const [panel, setPanel] = useState<AccountPanelData | null>(null);
  const [loading, startTransition] = useTransition();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [enrichResult, setEnrichResult] = useState<{ ok: boolean; error?: string; wroteHours?: boolean; wroteSummary?: boolean; skippedReason?: string } | null>(null);

  useEffect(() => {
    setPanel(null);
    setEnrichResult(null);
    setLoadError(null);
    if (!item.account_id) return;
    const accountId = item.account_id;
    let cancelled = false;
    startTransition(async () => {
      try {
        const res = await apiFetch(`/api/prospect/account/${accountId}`);
        const j = await res.json();
        if (cancelled) return;
        if (j.ok) setPanel(j.account);
        else setLoadError("Couldn't load this account.");
      } catch {
        if (!cancelled) setLoadError("Couldn't load this account.");
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.account_id]);

  /** Find Contacts writes straight to the OS; this is how its panel gets
   *  back into the call card without a full page reload. Best effort: the
   *  Find Contacts panel already shows what it did even if this refetch
   *  itself fails. */
  async function refreshPanel() {
    if (!item.account_id) return;
    try {
      const res = await apiFetch(`/api/prospect/account/${item.account_id}`);
      const j = await res.json();
      if (j.ok) setPanel(j.account);
    } catch {
      // best effort
    }
  }

  async function handleEnrich() {
    if (!item.account_id || enriching) return;
    setEnriching(true);
    setEnrichResult(null);
    try {
      const res = await apiFetch("/api/prospect/enrich", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": newId() },
        body: JSON.stringify({ account_id: item.account_id }),
      });
      const j = await res.json();
      const result = j.ok ? j.result : { ok: false, error: j.error };
      setEnrichResult(result);
      if (result.ok && (result.wroteHours || result.wroteSummary)) {
        setPanel((p) =>
          p
            ? {
                ...p,
                businessHours: result.wroteHours ? result.businessHours : p.businessHours,
                currentState: result.wroteSummary ? result.currentState : p.currentState,
                futureState: result.wroteSummary ? result.futureState : p.futureState,
                impact: result.wroteSummary ? result.impact : p.impact,
              }
            : p,
        );
      }
    } finally {
      setEnriching(false);
    }
  }

  const phone = panel?.phone ?? item.displayPhone;
  const address = panel ? fullAddress({ street: panel.street, city: panel.city, state: panel.state, postal: panel.postal }) : null;
  const area = panel?.area ? (areas.find((a) => a.id === panel.area) ?? null) : null;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-[14rem] flex-1">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <div className="text-[20px] leading-tight font-semibold tracking-[-0.01em] break-words text-[#14201B]">{item.displayName}</div>
              {panel?.businessHours && <OpenBadge businessHours={panel.businessHours} />}
              {area && (
                <span className="inline-flex items-center gap-1.5 text-[13px] text-[#5B6560]">
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: area.color }} />
                  {area.label}
                </span>
              )}
            </div>
            {panel && panel.channel !== "unknown" && <div className="mt-0.5 text-[13.5px] text-[#5B6560]">{panel.channel.replace(/_/g, " ")}</div>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {phone && (
              <a href={`tel:${phone.replace(/[^0-9+]/g, "")}`} className={callBtn}>
                <Ico name="phone" size={14} />
                Call {phone}
              </a>
            )}
            {item.account_id && (
              <button type="button" onClick={handleEnrich} disabled={enriching} className={`${ghostBtn} whitespace-nowrap`}>
                <RefreshIcon size={13} />
                {enriching ? "Enriching" : "Enrich further"}
              </button>
            )}
          </div>
        </div>

        {panel && panel.contacts.length > 0 && (
          <div className="mt-3 flex flex-col gap-2 border-t border-[#E2DFD5] pt-3">
            <span className="text-[11.5px] tracking-[0.1em] text-[#8A928C] uppercase">Contacts</span>
            {panel.contacts.map((c) => (
              <div key={c.id} className="flex flex-wrap items-baseline justify-between gap-2 text-[13.5px]">
                <span className="flex flex-wrap items-center gap-1.5 font-medium text-[#3D4A44]">
                  {c.name}
                  {c.title ? `, ${c.title}` : ""}
                  {c.isDecisionMaker && <span className="rounded bg-[#ECEAE1] px-1.5 py-0.5 text-[10.5px] font-medium tracking-wide text-[#3D4A44] uppercase">Decision maker</span>}
                </span>
                {c.phone ? (
                  <a href={`tel:${c.phone.replace(/[^0-9+]/g, "")}`} className="shrink-0 text-[13.5px] font-medium text-[#3D6B4A] hover:underline">
                    {c.phone}
                  </a>
                ) : c.email ? (
                  <a href={`mailto:${c.email}`} className="shrink-0 text-[13.5px] text-[#5B6560] hover:underline">
                    {c.email}
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {item.account_id && (
          <div className="mt-3 border-t border-[#E2DFD5] pt-3">
            <FindContacts accountId={item.account_id} onUpdated={refreshPanel} />
          </div>
        )}

        {panel && item.account_id && (
          <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-[#E2DFD5] pt-3">
            <PotentialGradeInline key={`grade-${panel.id}`} accountId={panel.id} value={panel.potentialJuan} />
            <PhoneEditable key={`phone-${panel.id}`} accountId={panel.id} phone={panel.phone} />
          </div>
        )}

        {loading && <div className="mt-3 text-[13.5px] text-[#8A928C]">Loading account</div>}

        {loadError && !loading && (
          <div className="mt-3 text-[13.5px] text-[#5B6560]">Couldn&rsquo;t load this account. You can still call and mark it done.</div>
        )}

        {panel && (
          <>
            {/* The Angle: current state, future state, impact. Real for an
                account already in the book; a brand-new business renders
                absent instead of a guess (no fabricated opening line). */}
            {(panel.currentState || panel.futureState || panel.impact) && (
              <div className="mt-3 rounded-md border border-[#E2DFD5] bg-[#FAF9F5] p-3 text-[14px] leading-relaxed text-[#3D4A44]">
                <div className="flex flex-col gap-1">
                  {panel.currentState && <div>{panel.currentState}</div>}
                  {panel.futureState && <div>{panel.futureState}</div>}
                  {panel.impact && <div>{panel.impact}</div>}
                </div>
              </div>
            )}

            <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-md border border-[#E2DFD5] p-3 text-[14px]">
              <Fact label="Last purchase" value={exactDaysAgo(panel.lastOrderAt)} />
              <Fact label="Due purchase" value={dueInDays(panel.expectedReorderAt)} />
              <Fact label="Lifetime value" value={panel.lifetimeRevenue != null ? money(panel.lifetimeRevenue) : null} />
              <Fact label="Status" value={panel.leadStatus} />
            </div>

            {enrichResult && !enriching && (
              <div className="mt-2.5">
                {enrichResult.ok ? (
                  <SuccessNote
                    title={enrichResult.wroteHours || enrichResult.wroteSummary ? "Enriched" : "Nothing new found"}
                    detail={[enrichResult.wroteHours ? "Hours updated." : null, enrichResult.wroteSummary ? "Angle filled." : null, !enrichResult.wroteHours && !enrichResult.wroteSummary ? (enrichResult.skippedReason ?? "The website, Google Maps, and order history had nothing new to add.") : null].filter(Boolean).join(" ")}
                  />
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[13.5px] text-[#8A6D2F]">
                    <Ico name="alert" size={13} />
                    Enrich further failed.
                  </span>
                )}
              </div>
            )}

            {panel.purchases && (
              <div className="mt-3 border-t border-[#E2DFD5] pt-3">
                <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[11.5px] tracking-[0.1em] text-[#8A928C] uppercase">
                  <span>Main purchases</span>
                  <span className="text-[12px] normal-case tracking-normal">{panel.purchases.orderCount} order{panel.purchases.orderCount === 1 ? "" : "s"}</span>
                </div>
                <ul className="flex flex-col divide-y divide-[#EDEBE3]">
                  {panel.purchases.topItems.map((it) => (
                    <li key={it.name} className="flex items-baseline justify-between gap-3 py-1.5 text-[14px]">
                      <span className="min-w-0 truncate">{it.name}</span>
                      <span className="shrink-0 tabular-nums text-[#5B6560]">
                        x{it.qty} <span className="text-[#8A928C]">, {money(it.revenueCents / 100)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                {panel.purchases.smallItemNames.length > 0 && <div className="mt-1.5 text-[13px] text-[#8A928C]">Small amounts of {panel.purchases.smallItemNames.join(", ")}.</div>}
              </div>
            )}

            <div className="mt-3 flex flex-col gap-1.5">
              <Fact label="Address" value={address} />
            </div>

            {panel.businessHours && (
              <div className="mt-3 flex flex-col gap-1 border-t border-[#E2DFD5] pt-3">
                <span className="text-[11.5px] tracking-[0.1em] text-[#8A928C] uppercase">Hours</span>
                {Object.entries(panel.businessHours).map(([day, ranges]) => {
                  const isToday = day === laTodayKey();
                  return (
                    <div key={day} className={`flex items-baseline justify-between gap-3 text-[14px] ${isToday ? "font-medium" : ""}`}>
                      <span className={`capitalize ${isToday ? "text-[#14201B]" : "text-[#8A928C]"}`}>
                        {day}
                        {isToday ? " (today)" : ""}
                      </span>
                      <span className={`tabular-nums ${isToday ? "text-[#14201B]" : "text-[#3D4A44]"}`}>{ranges.length ? ranges.map((r) => r.join(" to ")).join(", ") : "closed"}</span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-4">
              {panel.website && (
                <a href={panel.website.startsWith("http") ? panel.website : `https://${panel.website}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-1.5 text-[13.5px] font-medium text-[#3D6B4A] hover:underline">
                  <Ico name="globe" size={13} />
                  Open website
                </a>
              )}
              <a
                href={googleMapsUrl({ name: panel.name, address: fullAddress({ street: panel.street, city: panel.city, state: panel.state, postal: panel.postal }), lat: panel.lat, lng: panel.lng })}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] items-center gap-1.5 text-[13.5px] font-medium text-[#3D6B4A] hover:underline"
              >
                <Ico name="pin" size={13} />
                Open in Google Maps
              </a>
              {panel.hubspotCompanyId && (
                <a href={HUBSPOT_COMPANY_URL(panel.hubspotCompanyId)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center gap-1.5 text-[13.5px] font-medium text-[#5B6560] hover:text-[#14201B]">
                  <Ico name="hubspot" size={13} />
                  Open in HubSpot
                </a>
              )}
            </div>

            {panel.activities.length > 0 && (
              <div className="mt-3 flex flex-col gap-2 border-t border-[#E2DFD5] pt-3">
                <span className="text-[11.5px] tracking-[0.1em] text-[#8A928C] uppercase">Meetings and calls</span>
                {panel.activities.map((act, i) => (
                  <div key={`${act.at}-${i}`} className="rounded-md bg-[#FAF9F5] p-2.5 text-[13.5px] text-[#5B6560]">
                    <span className="font-medium text-[#3D4A44] capitalize">{act.kind.replace(/_/g, " ")}</span> <span className="text-[#8A928C]">{daysAgo(act.at)}</span>
                    {act.detail && <div className="mt-0.5 whitespace-pre-wrap">{act.detail}</div>}
                  </div>
                ))}
              </div>
            )}

          </>
        )}
      </Card>

      {showSuccess ? (
        <SuccessNote title="Done" />
      ) : (
        item.status === "pending" &&
        !item.id.startsWith("unscheduled:") && (
          <button onClick={onDone} className={primaryBtn}>
            <Ico name="check" size={14} />
            Mark done
          </button>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ranked opportunities (right rail on desktop, below the panel on phone)
// ---------------------------------------------------------------------------

function RankedList({ ranked, areaColor, onView }: { ranked: RankedAccount[]; areaColor: Record<string, string>; onView: (r: RankedAccount) => void }) {
  if (ranked.length === 0) return null;
  return (
    <Card>
      <div className="mb-2 text-[11.5px] tracking-[0.1em] text-[#8A928C] uppercase">Ranked opportunities</div>
      <ul className="flex flex-col divide-y divide-[#EDEBE3]">
        {ranked.map((r) => (
          <li key={r.id} className="flex items-start gap-2 py-2">
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium tabular-nums ${r.band === "now" ? "bg-[#F3E3C6] text-[#8A6D2F]" : "bg-[#ECEAE1] text-[#5B6560]"}`}>{r.score}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                {r.area && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: areaColor[r.area] ?? "#8A928C" }} />}
                <button type="button" onClick={() => onView(r)} className="truncate text-left text-[13.5px] font-medium text-[#14201B] transition-transform active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 hover:underline">
                  {r.name}
                </button>
              </div>
              <div className="truncate text-[12px] text-[#8A928C]" title={r.reason}>
                {r.reason}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function ProspectClient({
  initialItems, todayIso, days, areas, focusAccountId, focusAccountName, focusAccountPhone, topRanked,
}: {
  initialItems: ScheduleItem[];
  todayIso: string;
  days: number;
  areas: AreaGroup[];
  focusAccountId?: string | null;
  focusAccountName?: string | null;
  focusAccountPhone?: string | null;
  topRanked?: RankedAccount[];
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [active, setActive] = useState<ScheduleItem | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  const areaColor = useMemo(() => Object.fromEntries(areas.map((a) => [a.id, a.color])), [areas]);

  useEffect(() => {
    if (!focusAccountId) return;
    const existing = initialItems.find((it) => it.account_id === focusAccountId && it.status === "pending");
    if (existing) {
      setActive(existing);
      return;
    }
    if (!focusAccountName) return;
    setActive({
      id: `unscheduled:${focusAccountId}`,
      account_id: focusAccountId,
      prospect_name: null,
      prospect_phone: null,
      kind: "call",
      scheduled_date: todayIso,
      status: "pending",
      priority: null,
      rescheduled_at: null,
      displayName: focusAccountName,
      displayPhone: focusAccountPhone ?? null,
      area: null,
      businessHours: null,
      priorityScore: null,
      priorityReason: null,
      priorityBand: null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAccountId]);

  const dayIsos = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < days; i++) out.push(addDaysIso(todayIso, i));
    return out;
  }, [todayIso, days]);

  function addItem(item: ScheduleItem) {
    setItems((prev) => [...prev, item]);
  }

  const [statusErrors, setStatusErrors] = useState<Record<string, string>>({});
  const [doneNotice, setDoneNotice] = useState<Record<string, boolean>>({});

  function clearStatusError(id: string) {
    setStatusErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function markDone(id: string) {
    if (id.startsWith("unscheduled:") || doneNotice[id]) return;
    const prevItem = items.find((it) => it.id === id);
    if (!prevItem) return;
    clearStatusError(id);
    setDoneNotice((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await apiFetch("/api/prospect/status", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": newId() },
        body: JSON.stringify({ id, status: "done" }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error();
      // Success beat shows inline for a moment, then the row leaves the list.
      setTimeout(() => {
        setItems((prev) => prev.filter((it) => it.id !== id));
        setDoneNotice((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        setActive((cur) => (cur?.id === id ? null : cur));
      }, 1000);
    } catch {
      setDoneNotice((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setStatusErrors((prev) => ({ ...prev, [id]: "Couldn't save that. Try again." }));
    }
  }

  function reschedule(id: string, date: string) {
    const prevItem = items.find((it) => it.id === id);
    if (!prevItem) return;
    const prevDate = prevItem.scheduled_date;
    const prevRescheduledAt = prevItem.rescheduled_at;
    const nowIso = new Date().toISOString();
    clearStatusError(id);
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, scheduled_date: date, rescheduled_at: nowIso } : it)));
    setActive((cur) => (cur?.id === id ? { ...cur, scheduled_date: date, rescheduled_at: nowIso } : cur));
    (async () => {
      try {
        const res = await apiFetch("/api/prospect/reschedule", {
          method: "POST",
          headers: { "content-type": "application/json", "Idempotency-Key": newId() },
          body: JSON.stringify({ id, scheduled_date: date }),
        });
        const j = await res.json();
        if (!j.ok) throw new Error();
      } catch {
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, scheduled_date: prevDate, rescheduled_at: prevRescheduledAt } : it)));
        setActive((cur) => (cur?.id === id ? { ...cur, scheduled_date: prevDate, rescheduled_at: prevRescheduledAt } : cur));
        setStatusErrors((prev) => ({ ...prev, [id]: "Couldn't move that. Try again." }));
      }
    })();
  }

  function viewHit(hit: SearchHit) {
    const existing = items.find((it) => it.account_id === hit.accountId && it.status === "pending");
    if (existing) {
      setActive(existing);
      return;
    }
    setActive({
      id: `unscheduled:${hit.accountId}`,
      account_id: hit.accountId,
      prospect_name: null,
      prospect_phone: null,
      kind: "call",
      scheduled_date: todayIso,
      status: "pending",
      priority: null,
      rescheduled_at: null,
      displayName: hit.accountName,
      displayPhone: hit.phone,
      area: hit.area,
      businessHours: null,
      priorityScore: null,
      priorityReason: null,
      priorityBand: null,
    });
  }

  function viewRanked(r: RankedAccount) {
    const existing = items.find((it) => it.account_id === r.id && it.status === "pending");
    setActive(
      existing ?? {
        id: `unscheduled:${r.id}`,
        account_id: r.id,
        prospect_name: null,
        prospect_phone: null,
        kind: "call",
        scheduled_date: todayIso,
        status: "pending",
        priority: null,
        rescheduled_at: null,
        displayName: r.name,
        displayPhone: null,
        area: r.area,
        businessHours: null,
        priorityScore: r.score,
        priorityReason: r.reason,
        priorityBand: r.band as ScheduleItem["priorityBand"],
      },
    );
    // Client-side navigation, not a full page reload: keeps the account
    // shareable in the URL without the <a href> reload the review flagged.
    router.replace(`?account=${r.id}`, { scroll: false });
  }

  return (
    <div className="flex flex-col gap-4">
      <GlobalSearch todayIso={todayIso} onView={viewHit} onAdded={addItem} />

      <div className="@container">
      <div className="flex flex-col gap-6 @min-[720px]:grid @min-[720px]:grid-cols-[minmax(0,300px)_minmax(0,1fr)] @min-[720px]:grid-rows-[auto_1fr] @min-[720px]:items-start @min-[720px]:[grid-template-areas:'days_panel''rank_panel'] @min-[1000px]:grid-cols-[300px_minmax(0,1fr)_260px] @min-[1000px]:grid-rows-[auto] @min-[1000px]:[grid-template-areas:'days_panel_rank']">
        {topRanked && topRanked.length > 0 && (
          <div className="order-1 flex w-full min-w-0 flex-col gap-4 @min-[720px]:[grid-area:rank]">
            <RankedList ranked={topRanked} areaColor={areaColor} onView={viewRanked} />
          </div>
        )}

        <div className="order-2 flex w-full min-w-0 flex-col gap-4 @min-[720px]:[grid-area:days]">
          {dayIsos.map((iso) => {
            const dayItems = items
              .filter((it) => it.scheduled_date === iso && it.status === "pending")
              .sort((a, b) => {
                const rank: Record<SdrPriority, number> = { high: 3, mid: 2, low: 1 };
                const pd = (b.priority ? rank[b.priority] : 0) - (a.priority ? rank[a.priority] : 0);
                if (pd !== 0) return pd;
                return (b.priorityScore ?? -1) - (a.priorityScore ?? -1);
              });
            return (
              <div key={iso} className="rounded-lg border border-[#E2DFD5] bg-white p-3">
                <div className="mb-2 text-[12.5px] font-semibold tracking-[0.06em] text-[#5B6560] uppercase">{dayLabel(iso, todayIso)}</div>
                <ul className="flex flex-col gap-1.5">
                  {dayItems.map((it) => (
                    <ScheduleRow
                      key={it.id}
                      item={it}
                      active={active?.id === it.id}
                      onSelect={() => setActive(it)}
                      onDone={() => markDone(it.id)}
                      onReschedule={(date) => reschedule(it.id, date)}
                      todayIso={todayIso}
                      statusError={statusErrors[it.id]}
                      showSuccess={doneNotice[it.id]}
                    />
                  ))}
                </ul>
                <div className="mt-2">
                  <AddToDayForm date={iso} onAdded={addItem} />
                </div>
              </div>
            );
          })}
        </div>

        <div ref={panelRef} className="order-3 min-w-0 scroll-mt-3 @min-[720px]:[grid-area:panel]">
          {active ? (
            <AccountPanel item={active} areas={areas} onDone={() => markDone(active.id)} showSuccess={doneNotice[active.id]} />
          ) : (
            <div className="h-40 rounded-lg border border-dashed border-[#D8D4C8]" />
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
