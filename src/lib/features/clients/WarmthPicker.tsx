"use client";

import { useState } from "react";
import { apiFetch } from "../../core/api";

const LEVELS = [
  { value: "urgent", label: "Urgent" },
  { value: "hot", label: "Hot" },
  { value: "normal", label: "Normal" },
  { value: "cold", label: "Cold" },
] as const;

/** Warmth, shown and editable. Saves on tap; a failed save puts the old value back and says so in grey. */
export function WarmthPicker({
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
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="text-[11.5px] uppercase tracking-[0.06em] text-[#8A928C]">Warmth</span>
        <div className="flex flex-wrap gap-1">
          {LEVELS.map((l) => (
            <button
              key={l.value}
              type="button"
              disabled={busy}
              aria-pressed={value === l.value}
              onClick={() => pick(l.value)}
              className={`min-h-11 rounded px-3 text-[13px] font-semibold transition-colors ${
                value === l.value ? "bg-[#14201B] text-[#F7F6F1]" : "bg-[#ECEAE1] text-[#3D4A44] hover:bg-[#E2DFD5]"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      {error && <span className="text-[12px] text-[#8A928C]">Not saved: {error}</span>}
    </div>
  );
}
