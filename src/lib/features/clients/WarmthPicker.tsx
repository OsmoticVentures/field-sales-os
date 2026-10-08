"use client";

import { useState } from "react";
import { apiFetch } from "../../core/api";
import { READINESS_COLOR } from "../route/account-filters";

const LEVELS = [
  { value: "urgent", label: "Urgent" },
  { value: "hot", label: "Hot" },
  { value: "normal", label: "Normal" },
  { value: "cold", label: "Cold" },
  { value: "corporate", label: "Corporate" },
] as const;

/** Stroke icons for the four readiness levels, drawn on a 24 grid. */
export function ReadinessIcon({ level, size = 16 }: { level: string; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (level === "urgent")
    return (
      <svg {...common}>
        <path d="M12 3v11" />
        <circle cx="12" cy="19" r="1.2" />
      </svg>
    );
  if (level === "hot")
    return (
      <svg {...common}>
        <path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.2 2-4.2.2 1.4.9 2.2 1.8 2.6C10.5 8.5 11 5.5 12 3z" />
      </svg>
    );
  if (level === "cold")
    return (
      <svg {...common}>
        <path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9" />
      </svg>
    );
  if (level === "corporate")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M15 9.6a3.6 3.6 0 1 0 0 4.8" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M5 12h14" />
    </svg>
  );
}

export const READINESS_LEVELS = ["urgent", "hot", "normal", "cold", "corporate"] as const;

/** Four tappable readiness buttons, coloured like the map. One tap saves. Icon only; the name is the tooltip. */
export function ReadinessButtons({
  accountId,
  value: initial,
  onSaved,
}: {
  accountId: string;
  value: string | null;
  onSaved?: (value: string) => void;
}) {
  const [value, setValue] = useState<string | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(next: string) {
    if (busy || next === value) return;
    const prev = value;
    setValue(next);
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/visit/account-read", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ account_id: accountId, readiness: next }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `Could not save (${res.status}).`);
      onSaved?.(next);
    } catch (e) {
      setValue(prev);
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex gap-0.5">
        {READINESS_LEVELS.map((l) => {
          const on = value === l;
          const color = READINESS_COLOR[l];
          return (
            <button
              key={l}
              type="button"
              title={l[0].toUpperCase() + l.slice(1)}
              aria-label={l}
              aria-pressed={on}
              onClick={() => pick(l)}
              style={on ? { backgroundColor: color, color: "#fff" } : { backgroundColor: `${color}1A`, color }}
              className="inline-flex h-7 w-7 items-center justify-center rounded transition-opacity hover:opacity-80"
            >
              <ReadinessIcon level={l} size={15} />
            </button>
          );
        })}
      </span>
      {error && <span className="mt-0.5 max-w-[190px] text-[11px] leading-tight text-[#8A928C]">Not saved: {error}</span>}
    </span>
  );
}

/** Warmth, shown and editable. Saves on tap; a failed save puts the old value back and says so in grey. */
export function WarmthPicker({
  accountId,
  value: initial,
  onSaved,
  compact = false,
}: {
  accountId: string;
  value: string | null;
  onSaved?: (value: string) => void;
  /** Sits inside a card beside other label/value rows. */
  compact?: boolean;
}) {
  const [value, setValue] = useState<string | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(next: string) {
    if (busy || next === value) return;
    const prev = value;
    setValue(next);
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/visit/account-read", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ account_id: accountId, readiness: next }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `Could not save (${res.status}).`);
      onSaved?.(next);
    } catch (e) {
      setValue(prev);
      setError(e instanceof Error ? e.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1.5 ${compact ? "justify-between" : ""}`}>
        <span className={compact ? "text-[13px] text-[#5B6560]" : "text-[11.5px] uppercase tracking-[0.06em] text-[#8A928C]"}>Readiness</span>
        <div className="flex flex-wrap gap-1">
          {LEVELS.map((l) => (
            <button
              key={l.value}
              type="button"
              disabled={busy}
              aria-pressed={value === l.value}
              onClick={() => pick(l.value)}
              style={
                value === l.value
                  ? { backgroundColor: READINESS_COLOR[l.value], color: "#fff" }
                  : { backgroundColor: "#EEF0EC", color: "#5B6560" }
              }
              className={`inline-flex items-center gap-1.5 rounded font-semibold transition-opacity hover:opacity-80 ${compact ? "h-8 px-2.5 text-[12px]" : "min-h-11 px-3 text-[13px]"}`}
            >
              <ReadinessIcon level={l.value} size={14} />
              {l.label}
            </button>
          ))}
        </div>
      </div>
      {error && <span className="text-[12px] text-[#8A928C]">Not saved: {error}</span>}
    </div>
  );
}
