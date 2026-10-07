"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { apiFetch } from "../../../lib/core/api";
import { refreshAccount } from "../../../lib/core/phone-sync";
import { READINESS_COLOR } from "../../../lib/features/route/account-filters";

/** One editable tier field. Saves on blur or Enter and the tier re-reads at once; red text in place when it fails. */
export function MetricCell({ accountId, field, initial, label }: { accountId: string; field: string; initial: number | null; label: string }) {
  const [value, setValue] = useState(initial == null ? "" : String(initial));
  const [saved, setSaved] = useState(initial == null ? "" : String(initial));
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  const savedRef = useRef(saved);

  async function save(next: string = latest.current) {
    if (timer.current) clearTimeout(timer.current);
    if (next === savedRef.current) return;
    setError(null);
    try {
      const res = await apiFetch("/api/clients/metric", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, field, value: next.trim() === "" ? null : next }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `Could not save (${res.status}).`);
      setSaved(next);
      savedRef.current = next;
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
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          latest.current = v;
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => void save(v), 500);
        }}
        onBlur={() => void save()}
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

  const color = READINESS_COLOR[value as keyof typeof READINESS_COLOR] ?? null;

  return (
    <span className="inline-flex flex-col">
      <select
        aria-label="Readiness"
        value={value}
        onChange={(e) => change(e.target.value)}
        style={color ? { color, backgroundColor: `${color}1A`, borderColor: `${color}55` } : undefined}
        className={`h-8 rounded-md border px-2 text-[13.5px] font-medium capitalize outline-none focus:border-[#14201B] ${
          value === "" ? "border-dashed border-[#D8D4C6] bg-white text-[#8A928C]" : ""
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

const TIER_LETTERS = ["A", "B", "C", "D", "E"] as const;

/** The OS tier as A to E, always visible: one tap saves the pick as my own call (potential_juan). */
export function TierCell({ accountId, tier }: { accountId: string; tier: string | null }) {
  const router = useRouter();
  const [value, setValue] = useState<string | null>(tier);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(t: string) {
    if (busy || t === value) return;
    const prev = value;
    setValue(t);
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/prospect/account-fact", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ account_id: accountId, field: "potential_juan", value: t }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `Could not save (${res.status}).`);
      router.refresh();
      void refreshAccount(accountId);
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
        {TIER_LETTERS.map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={value === t}
            aria-label={`Tier ${t}`}
            onClick={() => pick(t)}
            className={`h-7 w-7 rounded text-[12px] font-semibold transition-colors ${
              value === t ? "bg-[#14201B] text-[#F7F6F1]" : "bg-[#ECEAE1] text-[#3D4A44] hover:bg-[#E2DFD5]"
            }`}
          >
            {t}
          </button>
        ))}
      </span>
      {error && <span className="mt-0.5 max-w-[190px] text-[11px] leading-tight text-[#8A928C]">Not saved: {error}</span>}
    </span>
  );
}
