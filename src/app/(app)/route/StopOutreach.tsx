"use client";

/**
 * Two buttons on a route stop (Juan, 2026-11-17): Add to SDR asks the
 * urgency, then the day, and queues the call on that day's SDR list through
 * /api/prospect/schedule (Juan, 2026-11-18, same priority-then-day shape as
 * the map card's Add to SDR), and Email only finds the angle
 * and files one draft on Outbound, never in Outlook Drafts
 * (lib/features/outbound/email-only.ts). Account stops only; a lunch or a
 * hotel has no account to call or write to. Email only carries no icon and a
 * tighter pad so it fits beside the remove button at 402px, where he asked.
 */
import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "@/lib/core/api";
import { Ico } from "@/lib/core/ui";
import type { EmailOnlyResult } from "@/lib/features/outbound/email-only";
import type { SdrPriority } from "@/lib/features/prospect/dal";
import { dayLabel, laTodayIso, workingDayIso } from "@/lib/features/route/field-week";

const SDR_PRIORITIES: { value: SdrPriority; label: string; tone: string }[] = [
  { value: "high", label: "High", tone: "bg-[#F3E3C6] text-[#8A6D2F] hover:bg-[#EDD8AD]" },
  { value: "mid", label: "Mid", tone: "bg-[#E7EDE4] text-[#3D6B4A] hover:bg-[#DCE6D8]" },
  { value: "low", label: "Low", tone: "bg-[#ECEAE1] text-[#5B6560] hover:bg-[#E2DFD5]" },
];

/** The next six call days from the working day, Sundays left out. */
function sdrDays(): string[] {
  const [y, m, d] = workingDayIso().split("-").map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  const out: string[] = [];
  while (out.length < 6) {
    if (cursor.getUTCDay() !== 0) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function dayText(iso: string): string {
  if (iso === laTodayIso()) return "Today";
  const { weekday, short } = dayLabel(iso);
  return `${weekday} ${short}`;
}

export function SdrStopButton({ accountId, title, className }: { accountId: string; title: string; className: string }) {
  const [step, setStep] = useState<"closed" | "urgency" | "day">("closed");
  const [priority, setPriority] = useState<SdrPriority | null>(null);
  const [queued, setQueued] = useState<{ priority: SdrPriority; day: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function queue(day: string) {
    if (!priority || !day) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/prospect/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ account_id: accountId, kind: "call", scheduled_date: day, priority }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? "Not added. Try again.");
      setQueued({ priority, day });
      setStep("closed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Not added. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setStep("closed");
    setPriority(null);
    setError(null);
  }

  if (queued) {
    const label = SDR_PRIORITIES.find((p) => p.value === queued.priority)?.label;
    return (
      <span className={`${className} pointer-events-none text-[#2C6A46]`} aria-label={`${title} is on SDR`}>
        <Ico name="check" size={13} />
        On SDR &middot; {label} &middot; {dayText(queued.day)}
      </span>
    );
  }

  if (step === "closed") {
    return (
      <button type="button" onClick={() => setStep("urgency")} aria-label={`Add ${title} to SDR`} className={className}>
        <Ico name="phone-arrow" size={13} />
        Add to SDR
      </button>
    );
  }

  const cancelBtn = (
    <button
      type="button"
      onClick={cancel}
      aria-label="Cancel"
      className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-[#8A928C] hover:bg-[#ECEAE1] hover:text-[#14201B]"
    >
      <Ico name="close" size={12} />
    </button>
  );

  if (step === "urgency" || !priority) {
    return (
      <div className="flex basis-full items-center gap-1.5">
        {SDR_PRIORITIES.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => {
              setPriority(p.value);
              setStep("day");
            }}
            className={`min-h-11 flex-1 rounded-md px-2 py-2 text-[13px] font-semibold transition-[background-color,transform] active:scale-[0.97] ${p.tone}`}
          >
            {p.label}
          </button>
        ))}
        {cancelBtn}
      </div>
    );
  }

  const days = sdrDays();
  return (
    <div className="flex basis-full flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {days.map((d, i) => (
          <button
            key={d}
            type="button"
            onClick={() => queue(d)}
            disabled={busy}
            className={
              i === 0
                ? "min-h-11 rounded-md bg-[#2C6A46] px-3.5 py-2 text-[13px] font-semibold text-white transition-transform active:scale-[0.97] disabled:opacity-40"
                : "min-h-11 rounded-md border border-[#E2DFD5] bg-white px-2.5 py-2 text-[12.5px] font-medium text-[#3D4A44] transition-[background-color,transform] hover:bg-[#FAF9F5] active:scale-[0.97] disabled:opacity-40"
            }
          >
            {dayText(d)}
          </button>
        ))}
        <input
          type="date"
          min={days[0]}
          disabled={busy}
          onChange={(e) => e.target.value && queue(e.target.value)}
          aria-label="Another day"
          className="min-h-11 rounded-md border border-[#E2DFD5] bg-white px-2 text-[12.5px] text-[#3D4A44] outline-none disabled:opacity-40"
        />
        {cancelBtn}
      </div>
      {error && <p className="text-[13px] font-medium text-[#8A2E2E]">{error}</p>}
    </div>
  );
}

export function EmailOnlyButton({ accountId, title, className }: { accountId: string; title: string; className: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EmailOnlyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch("/api/outbound/email-only", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ account_id: accountId }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; result?: EmailOnlyResult };
      if (!res.ok || j.ok === false || !j.result) throw new Error(j.error ?? "Not drafted. Try again.");
      setResult(j.result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Not drafted. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (result?.status === "drafted" || result?.status === "already_queued") {
    return (
      <Link
        href={`/outbound?account=${encodeURIComponent(accountId)}`}
        aria-label={`${title}'s email is on Outbound`}
        className={`${className} !px-2.5 text-[#2C6A46]`}
      >
        <Ico name="check" size={13} />
        Drafted
      </Link>
    );
  }
  const reason = (result?.status === "not_written" && result.reason) || error;
  return (
    <>
      <button
        type="button"
        onClick={run}
        disabled={busy}
        aria-label={`Draft an email to ${title} on Outbound`}
        className={`${className} !px-2.5 disabled:opacity-60`}
      >
        {busy ? "Drafting" : "Email only"}
      </button>
      {reason && <p className="basis-full text-[13px] font-medium text-[#8A2E2E]">{reason}</p>}
    </>
  );
}
