"use client";

/**
 * Two buttons on a route stop (Juan, 2026-11-17): SDR opens the account on
 * the SDR screen, filled in from its record (the same /prospect?account=
 * door as the account panel's Open in SDR), and Email only finds the angle
 * and files one draft on Outbound, never in Outlook Drafts
 * (lib/features/outbound/email-only.ts). Account stops only; a lunch or a
 * hotel has no account to call or write to.
 */
import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "@/lib/core/api";
import { Ico } from "@/lib/core/ui";
import type { EmailOnlyResult } from "@/lib/features/outbound/email-only";

export function SdrStopButton({ accountId, title, className }: { accountId: string; title: string; className: string }) {
  return (
    <Link href={`/prospect?account=${encodeURIComponent(accountId)}`} aria-label={`Open ${title} in SDR`} className={className}>
      <Ico name="phone-arrow" size={13} />
      SDR
    </Link>
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
      <Link href={`/outbound?account=${encodeURIComponent(accountId)}`} className={`${className} text-[#2C6A46]`}>
        <Ico name="check" size={13} />
        In Outbound
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
        className={`${className} disabled:opacity-60`}
      >
        <Ico name="mail" size={13} />
        {busy ? "Drafting" : "Email only"}
      </button>
      {reason && <p className="basis-full text-[13px] font-medium text-[#8A2E2E]">{reason}</p>}
    </>
  );
}
