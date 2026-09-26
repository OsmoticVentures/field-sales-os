"use client";

/**
 * The "waiting on you" list itself, client-owned so a handled draft can
 * leave it. Ported from the NutriBiotic OS's lib/outbound-ui.tsx
 * (DraftQueue, DraftCard, DraftActions), scoped to the email-only drafts
 * this port's composer produces. Order is the server's: most urgent first,
 * untouched here; this component only decides which rows are still open.
 */

import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "../../../lib/core/api";
import { Card, Ico, SuccessNote, ghostBtn, primaryBtn } from "../../../lib/core/ui";
import { daysAgo } from "../../../lib/features/prospect/format";
import type { Draft } from "../../../lib/features/outbound/dal";
import { owaComposeLink } from "../../../lib/features/outbound/mail-links";

type Row = { draft: Draft; accountName: string | null };

function CopyBodyButton({ body }: { body: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission refused. The body is on screen above either
      // way, so this degrades to selecting it by hand rather than to
      // nothing.
    }
  }

  return (
    <button type="button" onClick={copy} className={`${ghostBtn} bg-white px-3 text-[13px]`}>
      {copied ? "Copied" : "Copy body"}
    </button>
  );
}

function DraftCard({ row, onGone }: { row: Row; onGone: () => void }) {
  const d = row.draft;
  const [pending, setPending] = useState<"sent" | "dismissed" | null>(null);
  const [decided, setDecided] = useState<"sent" | "dismissed" | null>(null);
  const [note, setNote] = useState<{ title: string; detail?: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const outlook = d.to_email ? owaComposeLink(d.to_email, d.subject, d.body_md, d.bcc_email) : null;

  async function decide(decision: "sent" | "dismissed") {
    setPending(decision);
    setError(null);
    try {
      const res = await apiFetch("/api/outbound/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          id: d.id,
          decision,
          accountId: d.account_id,
          channel: d.channel,
          subject: d.subject,
          body: d.body_md,
        }),
      });
      const j = (await res.json()) as {
        ok: boolean;
        error?: string;
        result?: { filed: boolean; accountName: string | null; hubspotFiled: boolean; hubspotError: string | null } | null;
      };
      if (!res.ok || !j.ok) throw new Error(j.error ?? "That did not go through.");

      setDecided(decision);
      if (decision === "dismissed") {
        setNote({ title: "Dismissed" });
      } else if (j.result?.filed) {
        setNote({
          title: `Marked sent${j.result.accountName ? `: ${j.result.accountName}` : ""}`,
          detail: j.result.hubspotFiled ? null : j.result.hubspotError ?? "Not filed to HubSpot yet.",
        });
      } else {
        setNote({ title: "Marked sent", detail: "No account linked to this draft, so there was nowhere to file the note." });
      }
      setTimeout(onGone, 900);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not go through. Try again.");
    } finally {
      setPending(null);
    }
  }

  if (decided) {
    return (
      <Card>
        <SuccessNote title={note?.title ?? "Done"} detail={note?.detail} />
      </Card>
    );
  }

  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">Email</span>
        {d.subject && <span className="text-[14px] font-medium">{d.subject}</span>}
        {d.to_email && (
          <span className="text-[12px] text-[#8A928C]">
            {d.to_name ? `${d.to_name} · ` : ""}
            {d.to_email}
          </span>
        )}
        {d.account_id && (
          <Link href={`/account/${d.account_id}`} className="inline-flex items-center gap-1 text-[12px] font-medium text-[#5B6560] hover:text-[#14201B]">
            <Ico name="external" size={12} />
            {row.accountName ?? "Account"}
          </Link>
        )}
        <span className="text-[12px] text-[#8A928C]">{daysAgo(d.created_at)}</span>
        {(d.urgency === 2 || d.urgency === 1) && (
          <span
            className={
              d.urgency === 2
                ? "rounded bg-[#F3E3C6] px-1.5 py-0.5 text-[11px] font-medium text-[#8A6D2F]"
                : "rounded border border-[#DAD7CC] px-1.5 py-0.5 text-[11px] text-[#5B6560]"
            }
            title={d.urgency_reason ?? undefined}
          >
            {d.urgency === 2 ? "needs a reply today" : "soon"}
          </span>
        )}
        {d.play_key && (
          <span
            className="rounded bg-[#ECEAE1] px-1.5 py-0.5 text-[11px] text-[#3D4A44]"
            title="Which play produced this draft."
          >
            {d.play_key.replace(/_/g, " ")}
          </span>
        )}
      </div>

      <p className="max-w-[76ch] text-[13.5px] leading-relaxed whitespace-pre-wrap text-[#3D4A44]">{d.body_md}</p>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        {d.to_email && outlook && (
          <>
            <a href={outlook.href} target="_blank" rel="noopener noreferrer" className={`${primaryBtn} inline-flex items-center`}>
              Open in Outlook &rarr;
            </a>
            {outlook.bodyOmitted && (
              <>
                <CopyBodyButton body={d.body_md} />
                <span className="text-[12px] text-[#8A6D2F]">Too long to prefill. Outlook opens addressed, paste the body in.</span>
              </>
            )}
          </>
        )}
        {!d.to_email && (
          <>
            <CopyBodyButton body={d.body_md} />
            <span className="text-[12px] text-[#8A928C]">No email on file, paste into their site&rsquo;s contact form.</span>
          </>
        )}
        <button
          type="button"
          onClick={() => decide("sent")}
          disabled={pending !== null}
          title="Marks this sent on your word, the OS cannot verify a send on any channel."
          className={`${ghostBtn} bg-white px-3 text-[13px] disabled:opacity-50`}
        >
          {pending === "sent" ? "Marking sent" : "Mark sent"}
        </button>
        <button type="button" onClick={() => decide("dismissed")} disabled={pending !== null} className={`${ghostBtn} bg-white px-3 text-[13px] disabled:opacity-50`}>
          {pending === "dismissed" ? "Dismissing" : "Dismiss"}
        </button>
        {error && <span className="text-[12px] text-[#8A2E2E]">{error}</span>}
      </div>
    </Card>
  );
}

export function OutboundClient({
  initialRows,
  accountFilter,
  accountName,
}: {
  initialRows: Row[];
  accountFilter: string | null;
  accountName: string | null;
}) {
  const [gone, setGone] = useState<Set<string>>(new Set());
  const scoped = accountFilter ? initialRows.filter((r) => r.draft.account_id === accountFilter) : initialRows;
  const open = scoped.filter((r) => !gone.has(r.draft.id));

  return (
    <>
      {accountFilter && (
        <div className="mb-5 flex items-center justify-between rounded-md border border-[#E2DFD5] bg-[#FAF9F5] px-3 py-2">
          <span className="text-[13px] text-[#3D4A44]">
            Showing Outbound for <span className="font-medium">{accountName ?? "this account"}</span> only
          </span>
          <Link href="/outbound" className="text-[12.5px] font-medium text-[#5B6560] hover:text-[#14201B]">
            Show all
          </Link>
        </div>
      )}

      {open.length === 0 ? (
        <Card>
          <p className="text-[14px] text-[#5B6560]">{accountFilter ? "Nothing queued for this account right now." : "No drafts waiting on you."}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {open.map((row) => (
            <li key={row.draft.id}>
              <DraftCard row={row} onGone={() => setGone((prev) => new Set(prev).add(row.draft.id))} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
