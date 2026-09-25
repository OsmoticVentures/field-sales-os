"use client";

/**
 * Suggested returns, below the day's stops. Ported from the NutriBiotic OS's
 * RoutePanel (2026-09-25): accounts Juan said out loud he would go back to,
 * filtered to the active day. Only ever a stated "come back" from a logged
 * note (lib/features/route/return-suggestions.ts), never a model's guess.
 *
 * Two actions, each a door that already exists: Add to day goes through the
 * same cheapest-gap addEntry the Add a stop search uses, Add to SDR posts to
 * /api/prospect/schedule like the account view's own SDR button. Either one
 * resolves the directive so the route planner never offers it twice. The
 * source's third action, Generate outbound, needs the outreach composer,
 * which this app does not have yet.
 */

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/core/api";
import { Ico, SuccessNote, ghostBtn } from "@/lib/core/ui";
import { laTodayIso } from "@/lib/features/route/field-week";
import type { ReturnSuggestion } from "@/lib/features/route/return-suggestions";
import type { RouteAccount } from "@/lib/features/route/types";

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": newKey() },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** "Thursday, September 24", Los Angeles wall clock; null if unparseable. */
function loggedOnLabel(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric" });
}

/** "Wed, Sep 30, 12:00 PM", Los Angeles wall clock; null if unparseable. */
function statedTimeLabel(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const actionBtn = `${ghostBtn} inline-flex items-center gap-1.5 bg-white px-3 py-2 text-[13px] font-medium text-[#3D4A44]`;

export function ReturnSuggestions({
  activeDay,
  accountsById,
  inRoute,
  onAddToDay,
}: {
  activeDay: string;
  accountsById: Map<string, RouteAccount>;
  inRoute: Set<string>;
  onAddToDay: (a: RouteAccount) => void;
}) {
  const [suggestions, setSuggestions] = useState<ReturnSuggestion[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [successById, setSuccessById] = useState<Record<string, string>>({});
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/route/returns")
      .then((r) => r.json())
      .then((j: { ok: boolean; suggestions?: ReturnSuggestion[] }) => {
        if (j.ok && j.suggestions) setSuggestions(j.suggestions);
      })
      .catch(() => {});
  }, []);

  const visible = suggestions.filter(
    (s) => s.suggestedDate === activeDay && !hidden.has(s.accountId) && accountsById.has(s.accountId) && (!inRoute.has(s.accountId) || successById[s.accountId]),
  );
  if (visible.length === 0) return null;

  function settle(s: ReturnSuggestion, note: string) {
    setSuccessById((m) => ({ ...m, [s.accountId]: note }));
    postJson("/api/route/returns", { directiveId: s.directiveId, resolution: note }).catch(() => {});
    setTimeout(() => setHidden((h) => new Set(h).add(s.accountId)), 1000);
  }

  function addToDay(s: ReturnSuggestion) {
    const account = accountsById.get(s.accountId);
    if (!account) return;
    setErrorById((m) => ({ ...m, [s.accountId]: "" }));
    onAddToDay(account);
    settle(s, "Added to route");
  }

  async function addToSdr(s: ReturnSuggestion) {
    setErrorById((m) => ({ ...m, [s.accountId]: "" }));
    setBusyId(s.accountId);
    try {
      const res = await postJson("/api/prospect/schedule", {
        account_id: s.accountId,
        kind: "call",
        scheduled_date: laTodayIso(),
        priority: "mid",
      });
      if (res.ok) settle(s, "Added to SDR, today");
      else setErrorById((m) => ({ ...m, [s.accountId]: res.error ?? "Not scheduled. Try again." }));
    } catch {
      setErrorById((m) => ({ ...m, [s.accountId]: "Not scheduled. Try again." }));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-[#E2DFD5] bg-white">
      <div className="border-b border-[#EEECE3] px-4 py-2.5 text-[13px] font-semibold text-[#3D4A44]">Suggested returns</div>
      <ul className="divide-y divide-[#EEECE3]">
        {visible.map((s) => {
          const account = accountsById.get(s.accountId)!;
          const time = s.statedTime ? statedTimeLabel(s.statedTime) : null;
          const logged = loggedOnLabel(s.loggedAt);
          const success = successById[s.accountId];
          const error = errorById[s.accountId];
          return (
            <li key={s.accountId} className="flex flex-col gap-2 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="text-[14.5px] font-medium text-[#14201B]">{account.name}</span>
                  {account.city && <span className="text-[12.5px] text-[#8A928C]">{account.city}</span>}
                </div>
                {s.reason && <p className="mt-0.5 text-[13px] text-[#5B6560]">{s.reason}</p>}
                {s.quote && <p className="mt-0.5 text-[13px] italic text-[#5B6560]">&ldquo;{s.quote}&rdquo;</p>}
                {logged && <p className="mt-0.5 text-[12px] text-[#8A928C]">Because on {logged}</p>}
                {time && (
                  <p className="mt-0.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-[#2C6A46]">
                    <Ico name="clock" size={12} />
                    {time}
                  </p>
                )}
              </div>
              {success ? (
                <div className="max-w-xs">
                  <SuccessNote title={success} />
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button type="button" onClick={() => addToDay(s)} className={actionBtn}>
                    <Ico name="pin" size={13} />
                    Add to day
                  </button>
                  <button type="button" onClick={() => addToSdr(s)} disabled={busyId === s.accountId} className={actionBtn}>
                    <Ico name="phone" size={13} />
                    {busyId === s.accountId ? "Adding" : "Add to SDR"}
                  </button>
                </div>
              )}
              {error && <span className="text-[12.5px] text-[#8A2E2E]">{error}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
