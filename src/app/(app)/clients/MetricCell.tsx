"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** One editable tier field. Saves on blur or Enter and the tier re-reads at once; red text in place when it fails. */
export function MetricCell({ accountId, field, initial, label }: { accountId: string; field: string; initial: number | null; label: string }) {
  const [value, setValue] = useState(initial == null ? "" : String(initial));
  const [saved, setSaved] = useState(initial == null ? "" : String(initial));
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

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
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  }

  return (
    <span className="inline-flex flex-col items-end">
      <input
        inputMode="decimal"
        aria-label={label}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className={`h-8 w-16 rounded-md border bg-white px-2 text-right text-[13.5px] tabular-nums outline-none focus:border-[#14201B] ${
          value === "" ? "border-dashed border-[#D8D4C6]" : "border-[#E2DFD5]"
        }`}
      />
      {error && <span className="mt-0.5 max-w-[180px] text-[11px] leading-tight text-[#8A928C]">Not saved: {error}</span>}
    </span>
  );
}
