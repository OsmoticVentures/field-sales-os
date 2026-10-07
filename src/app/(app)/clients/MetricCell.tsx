"use client";

import { useState } from "react";

/** One editable tier field. Saves on blur or Enter; red text in place when it fails. */
export function MetricCell({ accountId, field, initial, label }: { accountId: string; field: string; initial: number | null; label: string }) {
  const [value, setValue] = useState(initial == null ? "" : String(initial));
  const [saved, setSaved] = useState(initial == null ? "" : String(initial));
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (value === saved) return;
    setError(null);
    try {
      const res = await fetch("/api/clients/metric", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, field, value: value.trim() === "" ? null : value }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error ?? "Could not save.");
      setSaved(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  }

  return (
    <input
      inputMode="decimal"
      aria-label={label}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      title={error ?? undefined}
      className={`h-8 w-16 rounded-md border bg-white px-2 text-right text-[13.5px] tabular-nums outline-none focus:border-[#14201B] ${
        error ? "border-[#B3402A] text-[#B3402A]" : value === "" ? "border-dashed border-[#D8D4C6]" : "border-[#E2DFD5]"
      }`}
    />
  );
}
