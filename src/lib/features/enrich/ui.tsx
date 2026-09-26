/**
 * Find Contacts: one button on the call card, one tap, the agency's own
 * contact-finding pipeline (tiers 1-4, pipeline.ts) run against this
 * account, right where Juan is about to make the call.
 *
 * The in-progress label cycles through the tiers the pass actually runs in
 * order (site, Places, a web search) on a fixed interval while the single
 * request is in flight; the pass itself is one route call, not a stream, so
 * this is a paced label, not a live status feed, and never claims a tier
 * finished before the response comes back.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../core/api";
import { Card, Ico, SuccessNote, ghostBtn, primaryBtn } from "../../core/ui";
import type { FindContactsResult, Proposal } from "./types";

function newId(): string {
  return crypto.randomUUID();
}

const TIER_LABELS = ["Reading the site", "Checking Google Places", "Searching the web"];

function useCyclingLabel(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) {
      setI(0);
      return;
    }
    const id = setInterval(() => setI((n) => (n + 1) % TIER_LABELS.length), 2200);
    return () => clearInterval(id);
  }, [active]);
  return TIER_LABELS[i];
}

const TIER_TAG: Record<string, string> = { site_team: "Site", site_other: "Site", places: "Google", websearch: "Web search" };

function SourceTag({ tier }: { tier: string }) {
  return <span className="rounded bg-[#ECEAE1] px-1.5 py-0.5 text-[10.5px] font-medium tracking-wide text-[#5B6560] uppercase">{TIER_TAG[tier] ?? tier}</span>;
}

function ProposalRow({ proposal, onResolved }: { proposal: Proposal; onResolved: () => void }) {
  const [pending, setPending] = useState<"accept" | "dismiss" | null>(null);
  const [done, setDone] = useState<"accepted" | "dismissed" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "accept" | "dismiss") {
    if (pending) return;
    setPending(action);
    setError(null);
    try {
      const res = await apiFetch("/api/enrich/proposal", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": newId() },
        body: JSON.stringify({ proposal, action }),
      });
      const j = await res.json();
      if (!j.ok || j.result?.ok === false) throw new Error(j.result?.error || j.error || "Could not apply that.");
      setDone(action === "accept" ? "accepted" : "dismissed");
      setTimeout(onResolved, 1100);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not apply that.");
    } finally {
      setPending(null);
    }
  }

  if (done) {
    return <SuccessNote title={done === "accepted" ? "Updated" : "Dismissed"} />;
  }

  return (
    <div className="rounded-md border border-[#E2DFD5] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13.5px] font-medium text-[#3D4A44]">
          {proposal.person_name ? `${proposal.person_name}, ` : ""}
          {proposal.field.replace(/_/g, " ")}
        </span>
        <SourceTag tier={proposal.source_tier} />
      </div>
      <div className="mt-1 text-[13.5px] text-[#5B6560]">
        {proposal.on_file ? <>On file: {proposal.on_file}. </> : null}
        Found: {proposal.found}.
      </div>
      <div className="mt-1 text-[12.5px] text-[#8A928C]">{proposal.evidence}</div>
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={() => act("accept")} disabled={pending !== null} className={primaryBtn}>
          {pending === "accept" ? "Saving" : "Accept"}
        </button>
        <button type="button" onClick={() => act("dismiss")} disabled={pending !== null} className={ghostBtn}>
          {pending === "dismiss" ? "Dismissing" : "Dismiss"}
        </button>
      </div>
      {error && (
        <div className="mt-1.5 inline-flex items-center gap-1.5 text-[12.5px] text-[#8A6D2F]">
          <Ico name="alert" size={12} />
          {error}
        </div>
      )}
    </div>
  );
}

export function FindContacts({ accountId, onUpdated }: { accountId: string; onUpdated?: () => void }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<FindContactsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = useCyclingLabel(running);
  const idRef = useRef(newId());

  async function run() {
    if (running) return;
    setRunning(true);
    setError(null);
    idRef.current = newId();
    try {
      const res = await apiFetch("/api/enrich/run", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": idRef.current },
        body: JSON.stringify({ account_id: accountId }),
      });
      const j = await res.json();
      if (!j.ok) throw new Error(j.error || "Find Contacts failed.");
      setResult(j.result);
      onUpdated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Find Contacts failed.");
    } finally {
      setRunning(false);
    }
  }

  function dropProposal(id: string) {
    setResult((r) => (r ? { ...r, proposals: r.proposals.filter((p) => p.id !== id) } : r));
  }

  return (
    <div className="flex flex-col gap-3">
      <button type="button" onClick={run} disabled={running} className={`${ghostBtn} whitespace-nowrap`}>
        <Ico name="search" size={13} />
        {running ? label : "Find contacts"}
      </button>

      {error && !running && (
        <span className="inline-flex items-center gap-1.5 text-[13.5px] text-[#8A6D2F]">
          <Ico name="alert" size={13} />
          {error}
        </span>
      )}

      {result && result.status === "blocked" && <div className="text-[13.5px] text-[#5B6560]">{result.error}</div>}

      {result && result.status === "ok" && (
        <Card className="!p-4">
          {result.different_business_signal && <div className="mb-3 text-[13.5px] leading-relaxed text-[#3D4A44]">{result.different_business_signal}</div>}
          {result.closed_signal && <div className="mb-3 text-[13.5px] leading-relaxed text-[#3D4A44]">{result.closed_signal.note}</div>}

          {result.people_found.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-[11.5px] tracking-[0.1em] text-[#8A928C] uppercase">People found</span>
              {result.people_found.map((p, i) => (
                <div key={`${p.name}-${i}`} className="flex flex-wrap items-baseline justify-between gap-2 text-[13.5px]">
                  <span className="flex flex-wrap items-center gap-1.5 font-medium text-[#3D4A44]">
                    {p.name}
                    {p.title ? `, ${p.title}` : ""}
                    {p.is_decision_maker && <span className="rounded bg-[#ECEAE1] px-1.5 py-0.5 text-[10.5px] font-medium tracking-wide text-[#3D4A44] uppercase">Decision maker</span>}
                  </span>
                  <SourceTag tier={p.source_tier} />
                </div>
              ))}
            </div>
          )}

          {result.filled.length > 0 && (
            <div className="mt-3 flex flex-col gap-1 border-t border-[#E2DFD5] pt-3">
              <span className="text-[11.5px] tracking-[0.1em] text-[#8A928C] uppercase">Filled in</span>
              {result.filled.map((f, i) => (
                <div key={`${f.field}-${i}`} className="text-[13.5px] text-[#3D4A44]">
                  {f.field.replace(/_/g, " ")}{f.contact_name ? ` for ${f.contact_name}` : ""}: {f.value}
                </div>
              ))}
            </div>
          )}

          {result.proposals.length > 0 && (
            <div className="mt-3 flex flex-col gap-2 border-t border-[#E2DFD5] pt-3">
              <span className="text-[11.5px] tracking-[0.1em] text-[#8A928C] uppercase">To confirm</span>
              {result.proposals.map((p) => (
                <ProposalRow key={p.id} proposal={p} onResolved={() => dropProposal(p.id)} />
              ))}
            </div>
          )}

          {result.not_found.length > 0 && (
            <div className="mt-3 flex flex-col gap-1 border-t border-[#E2DFD5] pt-3">
              <span className="text-[11.5px] tracking-[0.1em] text-[#8A928C] uppercase">Could not find</span>
              {result.not_found.map((n, i) => (
                <div key={`${n.field}-${i}`} className="text-[13.5px] text-[#8A928C]">
                  {n.field}, searched {n.searched}
                </div>
              ))}
            </div>
          )}

          {result.people_found.length === 0 && result.filled.length === 0 && result.proposals.length === 0 && result.not_found.length === 0 && (
            <div className="text-[13.5px] text-[#8A928C]">Nothing new to add.</div>
          )}
        </Card>
      )}
    </div>
  );
}
