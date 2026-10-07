"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFetch } from "../../../lib/core/api";
import { refreshAccount } from "../../../lib/core/phone-sync";

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
      const res = await apiFetch("/api/clients/metric", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, field, value: value.trim() === "" ? null : value }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `Could not save (${res.status}).`);
      setSaved(value);
      router.refresh();
      void refreshAccount(accountId);
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

const LEVELS = ["urgent", "hot", "normal", "cold"] as const;

/** Readiness for one row. Saves on change through the same route the client view uses. */
export function ReadinessCell({ accountId, initial }: { accountId: string; initial: string | null }) {
  const [value, setValue] = useState(initial ?? "");
  const [error, setError] = useState<string | null>(null);

  async function change(next: string) {
    const prev = value;
    setValue(next);
    setError(null);
    try {
      const res = await apiFetch("/api/visit/account-read", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ account_id: accountId, readiness: next }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `Could not save (${res.status}).`);
      void refreshAccount(accountId);
    } catch (e) {
      setValue(prev);
      setError(e instanceof Error ? e.message : "Could not save.");
    }
  }

  return (
    <span className="inline-flex flex-col">
      <select
        aria-label="Readiness"
        value={value}
        onChange={(e) => change(e.target.value)}
        className={`h-8 rounded-md border bg-white px-2 text-[13.5px] capitalize outline-none focus:border-[#14201B] ${
          value === "" ? "border-dashed border-[#D8D4C6] text-[#8A928C]" : "border-[#E2DFD5] text-[#3D4A44]"
        }`}
      >
        <option value="" disabled>
          Set
        </option>
        {LEVELS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      {error && <span className="mt-0.5 max-w-[160px] text-[11px] leading-tight text-[#8A928C]">Not saved: {error}</span>}
    </span>
  );
}
