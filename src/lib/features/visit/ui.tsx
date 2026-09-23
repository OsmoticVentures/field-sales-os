"use client";

/**
 * Visit Logger's client UI: the capture box, the review-before-commit card,
 * and the two resolvers (needs an account, needs a next step). Ported and
 * trimmed from portfolio/src/app/nutribiotic/lib/touchpoint-ui.tsx,
 * review-ui.tsx, new-account-ui.tsx, and next-step-ui.tsx.
 *
 * CUT FROM THE SOURCE (see the port's handback): photo attach (needs
 * lib/gdrive.ts, a shared module this feature is not allowed to touch),
 * the Potential/Readiness grading pills (lib/priority.ts, not ported), and
 * the Google-Places new-business search (replaced with a search of Juan's
 * own book, see search-accounts/route.ts). Every write goes through
 * apiFetch so it carries the /nb basePath, and every write that creates a
 * row carries its own Idempotency-Key, generated once per attempt and
 * reused on any retry of that same attempt, per PORTING.md.
 */

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { apiFetch } from "../../core/api";
import { Ico } from "../../core/ui";

/** A confirmation beat that also carries the HubSpot filing line, since
 *  lib/core/ui.tsx's SuccessNote does not. Local rather than an edit to the
 *  shared file, per this port's file-scope. */
function FiledNote({
  title,
  detail,
  hubspotFiled,
  hubspotId,
  hubspotError,
  meta,
}: {
  title: string;
  detail?: string | null;
  hubspotFiled?: boolean;
  hubspotId?: string | null;
  hubspotError?: string | null;
  meta?: ReactNode;
}) {
  return (
    <div className="rounded-md border border-[#E2DFD5] bg-[#FAF9F5] px-3 py-2.5 text-[13px] leading-relaxed text-[#3D4A44]">
      <div className="flex items-center gap-1.5 font-medium text-[#2C6A46]">
        <Ico name="check" size={13} />
        {title}
      </div>
      {detail && <div className="mt-1 text-[#5B6560]">{detail}</div>}
      {hubspotFiled !== undefined && (
        <div className={`mt-1.5 flex items-start gap-1.5 text-[12px] ${hubspotFiled ? "text-[#8A928C]" : "text-[#8A6D2F]"}`}>
          <Ico name={hubspotFiled ? "check" : "alert"} size={11} />
          <span>{hubspotFiled ? `Filed to HubSpot${hubspotId ? ` (${hubspotId})` : ""}.` : hubspotError ?? "Not filed to HubSpot."}</span>
        </div>
      )}
      {meta}
    </div>
  );
}

/** One retry-safe id per logical write attempt, per PORTING.md. */
function useIdempotencyKey(resetOn: unknown): string {
  const ref = useRef<string>("");
  if (!ref.current) ref.current = crypto.randomUUID();
  useEffect(() => {
    ref.current = crypto.randomUUID();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetOn]);
  return ref.current;
}

// ---------------------------------------------------------------------------
// types mirrored from the route handlers' JSON shapes
// ---------------------------------------------------------------------------

type FiledResult = {
  ok: true;
  touchpoint_id: string;
  accountName: string | null;
  accountId: string | null;
  needsAccount: false;
  needsNextStep: false;
  isFieldNote?: boolean;
  summary: string;
  peopleAdded: number;
  peopleUpdated: number;
  hubspotFiled: boolean;
  hubspotNoteId: string | null;
  hubspotError: string | null;
};

type NeedsAccountResult = {
  ok: true;
  touchpoint_id: string;
  needsAccount: true;
  needsNextStep: false;
  summary: string;
  businessNameGuess: string | null;
  matchAccountId: string | null;
  matchAccountName: string | null;
};

type NeedsNextStepResult = {
  ok: true;
  touchpoint_id: string;
  needsAccount: false;
  needsNextStep: true;
  accountId: string;
  accountName: string | null;
  summary: string;
};

type TouchpointApiResult = FiledResult | NeedsAccountResult | NeedsNextStepResult;

const KIND_OPTIONS = [
  { value: "meeting", label: "Meeting" },
  { value: "call", label: "Call" },
  { value: "email", label: "Email" },
  { value: "field_note", label: "Field note" },
] as const;
type KindOption = (typeof KIND_OPTIONS)[number]["value"];

// ---------------------------------------------------------------------------
// the capture box
// ---------------------------------------------------------------------------

export function TouchpointCapture() {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<KindOption>("meeting");
  const [kindTouched, setKindTouched] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<FiledResult | null>(null);
  const [needsAccount, setNeedsAccount] = useState<NeedsAccountResult | null>(null);
  const [needsNextStep, setNeedsNextStep] = useState<NeedsNextStepResult | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const key = useIdempotencyKey(null);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 2200);
    return () => clearTimeout(t);
  }, [success]);

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
  }

  function reset() {
    setText("");
    setKind("meeting");
    setKindTouched(false);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        autosize(textareaRef.current);
        textareaRef.current.focus({ preventScroll: true });
      }
    });
  }

  function submit() {
    const value = text;
    if (!value.trim() || pending) return;
    startTransition(async () => {
      setError(null);
      try {
        const res = await apiFetch("/api/visit/touchpoint", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify({ text: value, kindOverride: kindTouched ? kind : undefined }),
        });
        const data = await res.json();
        if (!data.ok) {
          setError(data.error || "That note did not file.");
          return;
        }
        const result = data.result as TouchpointApiResult;
        if (result.needsAccount) {
          setNeedsAccount(result);
          setText("");
          setKind("meeting");
          setKindTouched(false);
        } else if (result.needsNextStep) {
          setNeedsNextStep(result);
          setText("");
          setKind("meeting");
          setKindTouched(false);
        } else {
          setSuccess(result);
          reset();
        }
      } catch {
        setError("That note did not reach the server. Try again.");
      }
    });
  }

  return (
    <div className="mx-auto w-full max-w-[600px]">
      <div className="rounded-xl border border-[#E2DFD5] bg-white p-4 sm:p-5">
        {success ? (
          <button type="button" onClick={() => setSuccess(null)} className="block w-full cursor-pointer text-left">
            <FiledNote
              title={`Logged${success.accountName ? `: ${success.accountName}` : ""}`}
              detail={success.summary}
              hubspotFiled={success.isFieldNote ? undefined : success.hubspotFiled}
              hubspotId={success.hubspotNoteId}
              hubspotError={success.hubspotError}
              meta={
                <>
                  {(success.peopleAdded > 0 || success.peopleUpdated > 0) && (
                    <div className="mt-1.5 text-[12px] text-[#8A928C]">
                      {success.peopleAdded > 0 && `${success.peopleAdded} contact${success.peopleAdded === 1 ? "" : "s"} added`}
                      {success.peopleAdded > 0 && success.peopleUpdated > 0 && ", "}
                      {success.peopleUpdated > 0 && `${success.peopleUpdated} updated`}
                    </div>
                  )}
                  <div className="mt-1.5 text-[11px] uppercase tracking-[0.1em] text-[#A9AFA9]">Tap for the next one</div>
                </>
              }
            />
          </button>
        ) : needsAccount ? (
          <AccountMatchResolver
            touchpointId={needsAccount.touchpoint_id}
            nameGuess={needsAccount.businessNameGuess}
            matchAccountId={needsAccount.matchAccountId}
            matchAccountName={needsAccount.matchAccountName}
            onResolved={() => {
              setNeedsAccount(null);
              reset();
            }}
          />
        ) : needsNextStep ? (
          <NextStepResolver
            touchpointId={needsNextStep.touchpoint_id}
            accountName={needsNextStep.accountName}
            onResolved={() => {
              setNeedsNextStep(null);
              reset();
            }}
          />
        ) : (
          <>
            <div className="mb-3 flex gap-1.5">
              {KIND_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setKind(opt.value);
                    setKindTouched(true);
                  }}
                  className={`h-11 flex-1 rounded-md border px-2 text-[13px] font-medium transition-[transform,background-color,color] active:scale-[0.97] ${
                    kindTouched && kind === opt.value
                      ? "border-[#14201B] bg-[#14201B] text-[#F7F6F1]"
                      : "border-[#E2DFD5] bg-transparent text-[#5B6560]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => {
                const value = e.target.value;
                setText(value);
                autosize(e.target);
                if (!kindTouched && value.trim()) setKindTouched(true);
              }}
              placeholder="What just happened?"
              rows={5}
              autoFocus
              autoCapitalize="sentences"
              autoCorrect="on"
              spellCheck
              className="min-h-[132px] w-full resize-none border-none bg-transparent p-0 text-[16px] leading-relaxed text-[#14201B] placeholder:text-[#A9AFA9] focus:outline-none"
            />

            <div className="mt-3 flex items-center justify-end border-t border-[#EDEBE3] pt-3">
              <button
                type="button"
                onClick={submit}
                disabled={pending || !text.trim()}
                aria-label="Log this note"
                className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-[#14201B] px-6 text-[14.5px] font-medium text-[#F7F6F1] transition-[transform,opacity] active:scale-[0.97] disabled:opacity-30"
              >
                {pending ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                ) : (
                  <Ico name="send" size={17} />
                )}
                {pending ? "Logging" : "Log"}
              </button>
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="mt-3 rounded-md border border-[#E5D9BF] bg-[#FBF6E9] px-3 py-2.5 text-[13px] leading-relaxed text-[#8A6D2F]">
          {error}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// needs_account resolver
// ---------------------------------------------------------------------------

function AccountMatchResolver({
  touchpointId,
  nameGuess,
  matchAccountId,
  matchAccountName,
  onResolved,
}: {
  touchpointId: string;
  nameGuess: string | null;
  matchAccountId: string | null;
  matchAccountName: string | null;
  onResolved: () => void;
}) {
  const [matching, setMatching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [filed, setFiled] = useState<FiledResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(nameGuess ?? "");
  const [candidates, setCandidates] = useState<{ id: string; name: string; city: string | null }[]>([]);
  const [searching, setSearching] = useState(false);
  const key = useIdempotencyKey(touchpointId);

  useEffect(() => {
    if (!filed) return;
    const t = setTimeout(onResolved, 5000);
    return () => clearTimeout(t);
  }, [filed, onResolved]);

  async function resolve(body: Record<string, unknown>) {
    setError(null);
    try {
      const res = await apiFetch("/api/visit/resolve-account", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ touchpointId, ...body }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Could not file that.");
        return;
      }
      setFiled({ ok: true, touchpoint_id: touchpointId, needsAccount: false, needsNextStep: false, ...data.result });
    } catch {
      setError("That did not reach the server. Try again.");
    }
  }

  function confirmMatch() {
    if (!matchAccountId || !matchAccountName || matching) return;
    setMatching(true);
    resolve({ accountId: matchAccountId, accountName: matchAccountName }).finally(() => setMatching(false));
  }

  async function search() {
    if (!query.trim() || searching) return;
    setSearching(true);
    try {
      const res = await apiFetch(`/api/visit/search-accounts?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      setCandidates(data.ok ? data.candidates : []);
    } finally {
      setSearching(false);
    }
  }

  function pick(c: { id: string; name: string }) {
    if (matching) return;
    setMatching(true);
    resolve({ accountId: c.id, accountName: c.name }).finally(() => setMatching(false));
  }

  function createNew() {
    if (creating || !query.trim()) return;
    setCreating(true);
    resolve({ mode: "create", name: query.trim() }).finally(() => setCreating(false));
  }

  if (filed?.hubspotFiled !== undefined) {
    return (
      <button type="button" onClick={onResolved} className="block w-full text-left">
        <FiledNote
          title={`Matched ${filed.accountName ?? ""}`}
          detail={filed.summary}
          hubspotFiled={filed.hubspotFiled}
          hubspotId={filed.hubspotNoteId}
          hubspotError={filed.hubspotError}
          meta={<div className="mt-1.5 text-[11px] uppercase tracking-[0.1em] text-[#A9AFA9]">Tap for the next one</div>}
        />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-[#E2DFD5] bg-[#FAF9F5] p-3">
      {matchAccountId && matchAccountName && (
        <div>
          <div className="mb-1.5 text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">Client match</div>
          <div className="flex items-center gap-2 rounded-full border border-[#E2DFD5] bg-white py-1 pl-3 pr-1.5">
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#14201B]">{matchAccountName}</span>
            <button
              type="button"
              onClick={confirmMatch}
              disabled={matching}
              className="h-8 shrink-0 rounded-full bg-[#14201B] px-3 text-[11.5px] font-semibold tracking-wide text-[#F7F6F1] transition-transform active:scale-[0.97] disabled:opacity-40"
            >
              {matching ? "..." : "Yes"}
            </button>
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">Which account</div>
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Business name"
            className="h-11 min-w-0 flex-1 rounded-md border border-[#E2DFD5] bg-white px-3 text-[16px] text-[#14201B] placeholder:text-[#A9AFA9] focus:border-[#14201B] focus:outline-none"
          />
          <button
            type="button"
            onClick={search}
            disabled={searching || !query.trim()}
            aria-label="Search"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[#14201B] text-[#F7F6F1] transition-transform active:scale-[0.97] disabled:opacity-40"
          >
            <Ico name="search" size={16} />
          </button>
        </div>

        {candidates.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => pick(c)}
                disabled={matching}
                className="flex items-center gap-2 rounded-full border border-[#E2DFD5] bg-white py-1 pl-3 pr-1.5 text-[12.5px] text-[#14201B] transition-transform active:scale-[0.97] disabled:opacity-40"
              >
                {c.name}
                {c.city && <span className="text-[#8A928C]">· {c.city}</span>}
              </button>
            ))}
          </div>
        )}

        {query.trim() && (
          <button
            type="button"
            onClick={createNew}
            disabled={creating}
            className="mt-2 flex h-10 items-center gap-1.5 rounded-md border border-[#E2DFD5] bg-white px-3 text-[12.5px] font-medium text-[#5B6560] transition-transform active:scale-[0.97] disabled:opacity-40"
          >
            <Ico name="plus" size={13} />
            {creating ? "Creating…" : `New account: ${query.trim()}`}
          </button>
        )}
      </div>

      {error && <div className="text-[12px] text-[#8A6D2F]">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// needs_next_step resolver
// ---------------------------------------------------------------------------

function NextStepResolver({
  touchpointId,
  accountName,
  onResolved,
}: {
  touchpointId: string;
  accountName: string | null;
  onResolved: () => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [filed, setFiled] = useState<FiledResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useIdempotencyKey(touchpointId);

  useEffect(() => {
    if (!filed) return;
    const t = setTimeout(onResolved, 3500);
    return () => clearTimeout(t);
  }, [filed, onResolved]);

  async function submit(value: string) {
    if (pending || !value.trim()) return;
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch("/api/visit/resolve-next-step", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ touchpointId, nextStep: value }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Could not save that.");
        return;
      }
      setFiled({ ok: true, touchpoint_id: touchpointId, needsAccount: false, needsNextStep: false, ...data.result });
    } catch {
      setError("That did not reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }

  if (filed) {
    return (
      <button type="button" onClick={onResolved} className="block w-full text-left">
        <FiledNote
          title={`Logged${accountName ? `: ${accountName}` : ""}`}
          detail={filed.summary}
          hubspotFiled={filed.hubspotFiled}
          hubspotId={filed.hubspotNoteId}
          hubspotError={filed.hubspotError}
          meta={<div className="mt-1.5 text-[11px] uppercase tracking-[0.1em] text-[#A9AFA9]">Tap for the next one</div>}
        />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[#E2DFD5] bg-[#FAF9F5] p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.14em] text-[#8A6D2F]">
        <Ico name="alert" size={11} />
        Next step{accountName ? ` for ${accountName}` : ""}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Bring a sample Thursday, call back about pricing"
        rows={2}
        autoFocus
        className="min-h-[44px] w-full resize-none rounded-md border border-[#E2DFD5] bg-white p-2 text-[16px] leading-relaxed text-[#14201B] placeholder:text-[#A9AFA9] focus:outline-none"
      />
      {error && <div className="text-[12px] text-[#8A6D2F]">{error}</div>}
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => submit("No follow-up needed.")}
          disabled={pending}
          className="h-10 rounded-md border border-[#E2DFD5] px-2.5 text-[12px] text-[#5B6560] transition-transform active:scale-[0.97] disabled:opacity-40"
        >
          None needed
        </button>
        <button
          type="button"
          onClick={() => submit(text)}
          disabled={pending || !text.trim()}
          className="h-10 rounded-md bg-[#14201B] px-3 text-[12.5px] font-medium text-[#F7F6F1] transition-transform active:scale-[0.97] disabled:opacity-30"
        >
          {pending ? "Saving" : "Save"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the review backlog, /nb/visit/review
// ---------------------------------------------------------------------------

type QueuedTouchpoint = {
  id: string;
  account_id: string | null;
  raw_text: string;
  parsed: { business_name_guess?: string | null; account_confidence?: string } | null;
};

export function ReviewQueues() {
  const [pending, setPending] = useState<QueuedTouchpoint[] | null>(null);
  const [pendingNextSteps, setPendingNextSteps] = useState<QueuedTouchpoint[] | null>(null);
  const [accountNames, setAccountNames] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    apiFetch("/api/visit/queues", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json) => {
        if (!live) return;
        if (!json.ok) {
          setFailed(true);
          return;
        }
        setPending(json.pending ?? []);
        setPendingNextSteps(json.pendingNextSteps ?? []);
        setAccountNames(json.accountNames ?? {});
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  const drop = (id: string) => setResolvedIds((prev) => new Set(prev).add(id));

  if (failed) {
    return <div className="rounded-md border border-[#E5D9BF] bg-[#FBF6E9] px-3 py-2.5 text-[13px] text-[#8A6D2F]">Could not load the review queue.</div>;
  }
  if (pending === null || pendingNextSteps === null) {
    return <div className="text-[13px] text-[#8A928C]">Loading</div>;
  }

  const matchRows = pending.filter((tp) => !resolvedIds.has(tp.id));
  const stepRows = pendingNextSteps.filter((tp) => !resolvedIds.has(tp.id));

  if (matchRows.length === 0 && stepRows.length === 0) {
    return <div className="text-[13px] text-[#8A928C]">Nothing waiting.</div>;
  }

  return (
    <div className="flex flex-col gap-8">
      {matchRows.length > 0 && (
        <section>
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-[#8A928C]">
            Needs a match · {matchRows.length}
          </h2>
          <div className="flex flex-col gap-4">
            {matchRows.map((tp) => (
              <div key={tp.id} className="rounded-xl border border-[#E2DFD5] bg-white p-4">
                <p className="line-clamp-3 text-[13px] leading-relaxed text-[#3D4A44]">{tp.raw_text}</p>
                <div className="mt-3">
                  <AccountMatchResolver
                    touchpointId={tp.id}
                    nameGuess={tp.parsed?.business_name_guess ?? null}
                    matchAccountId={null}
                    matchAccountName={null}
                    onResolved={() => drop(tp.id)}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {stepRows.length > 0 && (
        <section>
          <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.14em] text-[#8A928C]">
            Needs a next step · {stepRows.length}
          </h2>
          <div className="flex flex-col gap-4">
            {stepRows.map((tp) => (
              <div key={tp.id} className="rounded-xl border border-[#E2DFD5] bg-white p-4">
                <p className="line-clamp-3 text-[13px] leading-relaxed text-[#3D4A44]">{tp.raw_text}</p>
                <div className="mt-3">
                  <NextStepResolver
                    touchpointId={tp.id}
                    accountName={tp.account_id ? accountNames[tp.account_id] ?? null : null}
                    onResolved={() => drop(tp.id)}
                  />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
