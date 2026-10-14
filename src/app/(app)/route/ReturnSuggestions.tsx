"use client";

/**
 * Suggested returns, below the day's stops. Ported from the NutriBiotic OS's
 * RoutePanel (2026-09-25): accounts Juan said out loud he would go back to,
 * filtered to the active day. Only ever a stated "come back" from a logged
 * note (lib/features/route/return-suggestions.ts), never a model's guess.
 * Every card has one shape: the name, one line led by the next step the
 * note names (call, email, text, visit), a detail only when it adds
 * something, then city, when it was said, and a time only when one was.
 * The button that matches the step is the dark one.
 *
 * Three actions, each a door that already exists: Add to day goes through the
 * same cheapest-gap addEntry the Add a stop search uses, Add to SDR posts to
 * /api/prospect/schedule like the account view's own SDR button, and
 * Generate outbound calls composeAsk through /api/outbound/draft-from-reason
 * (lib/features/outbound/actions.ts's draftAccountPitchFromReason), the same
 * grounding gate the account profile's own Draft outreach button holds
 * itself to, just fed the reason Juan types here instead of the account's
 * Gap Selling summary. Each resolves the directive so the route planner
 * never offers it twice. No window.open into a new tab (the house rule: a
 * new tab never opens itself, he taps it): the drafted row is reachable from
 * the app's own Outbound screen, behind More, whenever he wants it.
 */

import { useEffect, useState } from "react";
import { sees, useMe } from "../../../lib/core/me";
import { apiFetch, getJson, peekJson } from "@/lib/core/api";
import { Ico, SuccessNote, ghostBtn } from "@/lib/core/ui";
import { workingDayIso } from "@/lib/features/route/field-week";
import type { ReturnStep, ReturnSuggestion } from "@/lib/features/route/return-suggestions";
import type { RouteAccount } from "@/lib/features/route/types";

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2);
}

type PostResult = {
  ok: boolean;
  error?: string;
  result?: { status: "drafted" | "already_queued" | "not_written"; reason?: string };
};

async function postJson(path: string, body: unknown): Promise<PostResult> {
  const res = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": newKey() },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** "Oct 5", Los Angeles wall clock; null if unparseable. */
function loggedOnLabel(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric" });
}

/** "9:00 AM" when the stated time falls on the card's own day, "Tue, Oct 13,
 *  9:00 AM" otherwise; null for a date with no time (stored as midnight). */
function statedTimeLabel(iso: string, day: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const la = (o: Intl.DateTimeFormatOptions) => d.toLocaleString("en-US", { timeZone: "America/Los_Angeles", ...o });
  const hm = la({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (hm === "00:00") return null;
  const time = la({ hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) === day ? time : `${la({ weekday: "short", month: "short", day: "numeric" })}, ${time}`;
}

const KEEP_UPPER = /^(?:[^AEIOUY.']{2,5}|[A-Z]\.(?:[A-Z]\.)+|LLC|USA|II|III|IV|CBD|GNC|ND|MD|DC)$/;

/** An all-caps name ("DR. PURE NATURE") in the same case as every other card;
 *  a name already in mixed case is left exactly as written. */
function displayCase(text: string): string {
  if (/[a-z]/.test(text) || !/[A-Z]/.test(text)) return text;
  return text.replace(/[A-Z0-9][A-Z0-9'.]*/g, (w) => (KEEP_UPPER.test(w) ? w : `${w[0]}${w.slice(1).toLowerCase()}`));
}

const STEP_ICON: Record<ReturnStep, string> = { call: "phone", email: "mail", text: "send", visit: "route" };

const actionBtn = `${ghostBtn} inline-flex items-center gap-1.5 bg-white px-3 py-2 text-[13px] font-medium text-[#3D4A44]`;
/** The button that matches the card's own next step. */
const primaryBtn = `${ghostBtn} glass-dark inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-semibold text-[#F7F6F1]`;

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
  const me = useMe();
  const [suggestions, setSuggestions] = useState<ReturnSuggestion[]>(
    () => peekJson<{ ok: boolean; suggestions?: ReturnSuggestion[] }>("/api/route/returns")?.suggestions ?? [],
  );
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [successById, setSuccessById] = useState<Record<string, string>>({});
  const [errorById, setErrorById] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [whyOpenId, setWhyOpenId] = useState<string | null>(null);
  const [why, setWhy] = useState("");

  useEffect(() => {
    getJson<{ ok: boolean; suggestions?: ReturnSuggestion[] }>("/api/route/returns")
      .then((j) => {
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
        scheduled_date: workingDayIso(),
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

  async function generateOutbound(s: ReturnSuggestion) {
    const reason = why.trim();
    if (!reason) return;
    setErrorById((m) => ({ ...m, [s.accountId]: "" }));
    setBusyId(s.accountId);
    try {
      const res = await postJson("/api/outbound/draft-from-reason", { account_id: s.accountId, reason });
      const result = res.result;
      if (!res.ok || !result) {
        setErrorById((m) => ({ ...m, [s.accountId]: res.error ?? "Not drafted. Try again." }));
        return;
      }
      if (result.status === "not_written") {
        setErrorById((m) => ({ ...m, [s.accountId]: result.reason ?? "Not drafted." }));
        return;
      }
      setWhyOpenId(null);
      setWhy("");
      settle(s, result.status === "already_queued" ? "Already queued" : "Drafted");
    } catch {
      setErrorById((m) => ({ ...m, [s.accountId]: "Not drafted. Try again." }));
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
          const time = s.statedTime ? statedTimeLabel(s.statedTime, s.suggestedDate) : null;
          const logged = loggedOnLabel(s.loggedAt);
          const success = successById[s.accountId];
          const error = errorById[s.accountId];
          const canDraft = sees(me, "outbound");
          // A visit goes on the route, a call or text on SDR, an email to Draft.
          const match = s.step === "visit" ? "route" : s.step === "email" && canDraft ? "draft" : "sdr";
          return (
            <li key={s.accountId} className="flex flex-col gap-2.5 px-4 py-3.5">
              <div className="min-w-0">
                <div className="text-[15px] leading-snug font-semibold text-[#14201B]">{displayCase(account.name)}</div>
                <p className="mt-1 flex gap-1.5 text-[14px] leading-snug text-[#14201B]">
                  <span className="mt-[3px] shrink-0 text-[#2C6A46]">
                    <Ico name={STEP_ICON[s.step]} size={13} />
                  </span>
                  <span>{s.premise}</span>
                </p>
                {s.detail && <p className="mt-1 pl-[19px] text-[13px] leading-snug text-[#5B6560]">{s.detail}</p>}
                <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 pl-[19px] text-[12.5px] text-[#8A928C]">
                  {account.city && <span>{displayCase(account.city)}</span>}
                  {account.city && logged && <span aria-hidden>·</span>}
                  {logged && <span>Noted {logged}</span>}
                  {time && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="inline-flex items-center gap-1 font-medium text-[#2C6A46]">
                        <Ico name="clock" size={12} />
                        {time}
                      </span>
                    </>
                  )}
                </p>
              </div>
              {success ? (
                <div className="max-w-xs">
                  <SuccessNote title={success} />
                </div>
              ) : whyOpenId === s.accountId ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    value={why}
                    onChange={(e) => setWhy(e.target.value)}
                    placeholder="Why: what to say, what they asked for"
                    autoFocus
                    className="min-h-9 min-w-0 flex-1 rounded-md border border-[#E2DFD5] bg-[#FCFBF7] px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-[#A9AFA9] focus:border-[#8A928C]"
                  />
                  <button
                    type="button"
                    onClick={() => generateOutbound(s)}
                    disabled={busyId === s.accountId || !why.trim()}
                    className="min-h-9 glass-dark rounded-xl px-3 py-1.5 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busyId === s.accountId ? "Drafting" : "Generate"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setWhyOpenId(null);
                      setWhy("");
                    }}
                    className="min-h-9 rounded-md px-2 py-1.5 text-[12px] font-medium text-[#8A928C] hover:text-[#3D4A44]"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button type="button" onClick={() => addToDay(s)} className={match === "route" ? primaryBtn : actionBtn} title="Add to day">
                    <Ico name="route" size={13} />
                    Route
                  </button>
                  <button
                    type="button"
                    onClick={() => addToSdr(s)}
                    disabled={busyId === s.accountId}
                    className={match === "sdr" ? primaryBtn : actionBtn}
                    title="Add to SDR"
                  >
                    <Ico name="phone" size={13} />
                    {busyId === s.accountId ? "Adding" : "SDR"}
                  </button>
                  {canDraft && (
                    <button
                      type="button"
                      onClick={() => {
                        setWhyOpenId(s.accountId);
                        setWhy("");
                      }}
                      className={match === "draft" ? primaryBtn : actionBtn}
                      title="Generate outbound"
                    >
                      <Ico name="mail" size={13} />
                      Draft
                    </button>
                  )}
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
