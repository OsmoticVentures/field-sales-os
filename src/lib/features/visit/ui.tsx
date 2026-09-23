"use client";

/**
 * Visit Logger's client UI: the capture box, the review-before-commit card,
 * and the two resolvers (needs an account, needs a next step). Ported and
 * trimmed from portfolio/src/app/nutribiotic/lib/touchpoint-ui.tsx,
 * review-ui.tsx, new-account-ui.tsx, and next-step-ui.tsx.
 *
 * The Google-Places new-business search is replaced with a search of
 * Juan's own book (see search-accounts/route.ts). Every write goes through
 * apiFetch so it carries the /nb basePath, and every write that creates a
 * row carries its own Idempotency-Key, generated once per attempt and
 * reused on any retry of that same attempt, per PORTING.md.
 */

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { apiFetch } from "../../core/api";
import { Ico, SkeletonBar, ghostBtn, inputCls, primaryBtn } from "../../core/ui";

/** A small inline spinner for a button mid-write, in place of a "..." label. */
function Spinner({ light = true }: { light?: boolean }) {
  return (
    <span
      className={`inline-block h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 motion-reduce:animate-none ${
        light ? "border-white/40 border-t-white" : "border-[#14201B]/30 border-t-[#14201B]"
      }`}
    />
  );
}

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
        hubspotFiled === false && hubspotError === "CRM filing off" ? (
          <div className="mt-1.5 text-[12px] text-[#8A928C]">CRM filing off</div>
        ) : (
          <div className={`mt-1.5 flex items-start gap-1.5 text-[12px] ${hubspotFiled ? "text-[#8A928C]" : "text-[#8A6D2F]"}`}>
            <Ico name={hubspotFiled ? "check" : "alert"} size={11} />
            <span>{hubspotFiled ? `Filed to HubSpot${hubspotId ? ` (${hubspotId})` : ""}.` : hubspotError ?? "Not filed to HubSpot."}</span>
          </div>
        )
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
  { value: "field_note", label: "Note" },
] as const;
type KindOption = (typeof KIND_OPTIONS)[number]["value"];

const VISIT_GRADES = ["A", "B", "C", "D", "E"] as const;
type VisitGrade = (typeof VISIT_GRADES)[number];
const GRADE_TITLE: Record<VisitGrade, string> = {
  A: "A, very big",
  B: "B, big",
  C: "C, medium",
  D: "D, small",
  E: "E, very small",
};

type Readiness = "urgent" | "hot" | "normal" | "cold";
const READINESS_OPTIONS: { value: Readiness; icon: string; title: string; activeClass: string }[] = [
  { value: "urgent", icon: "urgent", title: "Urgent, ready now, +20 to priority", activeClass: "bg-[#9C4A44] text-[#F7F6F1]" },
  { value: "hot", icon: "hot", title: "Hot, close, +10 to priority", activeClass: "bg-[#A8703D] text-[#F7F6F1]" },
  { value: "normal", icon: "dot", title: "Normal, no change to priority", activeClass: "bg-[#14201B] text-[#F7F6F1]" },
  { value: "cold", icon: "snowflake", title: "Cold, not close, -10 to priority", activeClass: "bg-[#5C7E8C] text-[#F7F6F1]" },
];

/** Grade and readiness land only once the note has named its account, so a
 *  failed file never leaves a read on the wrong record. Fire and forget. */
function applyAccountRead(accountId: string | null, grade: VisitGrade | null, readiness: Readiness | null) {
  if (!accountId || (!grade && !readiness)) return;
  void apiFetch("/api/visit/account-read", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ account_id: accountId, grade: grade ?? undefined, readiness: readiness ?? undefined }),
  }).catch(() => {});
}

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
  const [grade, setGrade] = useState<VisitGrade | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [newCompany, setNewCompany] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoUiState, setPhotoUiState] = useState<"idle" | "uploading" | "error">("idle");
  const photoInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const key = useIdempotencyKey(null);
  // Held for the resolver path: the account is not known until it resolves.
  const heldRead = useRef<{ grade: VisitGrade | null; readiness: Readiness | null }>({ grade: null, readiness: null });

  async function attachPhoto(touchpointId: string, file: File) {
    setPhotoUiState("uploading");
    try {
      const form = new FormData();
      form.set("touchpoint_id", touchpointId);
      form.set("photo", file);
      form.set("idempotency_key", `${touchpointId}:${file.name}:${file.size}`);
      const res = await apiFetch("/api/visit/attach", { method: "POST", body: form });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Attach failed.");
      setPhotoUiState("idle");
    } catch {
      setPhotoUiState("error");
      setTimeout(() => setPhotoUiState("idle"), 2500);
    }
  }

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 1200);
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
    setGrade(null);
    setReadiness(null);
    setNewCompany(false);
    setPendingPhoto(null);
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
          body: JSON.stringify({ text: value, kindOverride: kindTouched ? kind : undefined, forceNewAccount: newCompany }),
        });
        const data = await res.json();
        if (!data.ok) {
          setError(data.error || "That note did not file.");
          return;
        }
        const result = data.result as TouchpointApiResult;
        if (pendingPhoto) void attachPhoto(result.touchpoint_id, pendingPhoto);
        if (result.needsAccount) {
          heldRead.current = { grade, readiness };
          setNeedsAccount(result);
        } else if (result.needsNextStep) {
          applyAccountRead(result.accountId, grade, readiness);
          setNeedsNextStep(result);
        } else {
          applyAccountRead(result.accountId, grade, readiness);
          setSuccess(result);
        }
        reset();
      } catch {
        setError("That note did not reach the server. Try again.");
      }
    });
  }

  return (
    <div className="w-full">
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
            onMatched={(accountId) => {
              applyAccountRead(accountId, heldRead.current.grade, heldRead.current.readiness);
              heldRead.current = { grade: null, readiness: null };
            }}
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
            <div className="mb-3 flex gap-1">
              {KIND_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setKind(opt.value);
                    setKindTouched(true);
                  }}
                  className={`h-11 flex-1 rounded-md border px-1.5 text-[13px] font-medium transition-[transform,background-color,color] active:scale-[0.97] ${
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
                setText(e.target.value);
                autosize(e.target);
              }}
              placeholder="What just happened?"
              rows={5}
              autoFocus
              autoCapitalize="sentences"
              autoCorrect="on"
              spellCheck
              className="min-h-[132px] w-full resize-none border-none bg-transparent p-0 text-[16px] leading-relaxed text-[#14201B] placeholder:text-[#A9AFA9] focus:outline-none"
            />

            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-[#EDEBE3] pt-3">
              <span className="text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">Potential</span>
              <div className="flex gap-1">
                {VISIT_GRADES.map((t) => {
                  const active = grade === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      aria-pressed={active}
                      title={GRADE_TITLE[t]}
                      onClick={() => setGrade(active ? null : t)}
                      className={`h-11 w-11 rounded-md text-[13px] font-semibold transition-[transform,background-color,color] active:scale-[0.97] sm:h-9 sm:w-9 ${
                        active ? "bg-[#14201B] text-[#F7F6F1]" : "bg-[#ECEAE1] text-[#3D4A44]"
                      }`}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
              <button
                type="button"
                aria-pressed={newCompany}
                onClick={() => setNewCompany((v) => !v)}
                title="Skip matching against your accounts"
                className={`ml-auto flex h-11 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-[transform,background-color,color] active:scale-[0.97] sm:h-9 ${
                  newCompany
                    ? "border-[#14201B] bg-[#14201B] text-[#F7F6F1]"
                    : "border-[#E2DFD5] bg-transparent text-[#5B6560]"
                }`}
              >
                <Ico name={newCompany ? "check" : "plus"} size={13} />
                New company
              </button>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-2">
              <span className="text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">Lead readiness</span>
              <div className="flex gap-1">
                {READINESS_OPTIONS.map((opt) => {
                  const active = readiness === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      aria-pressed={active}
                      aria-label={opt.title}
                      title={opt.title}
                      onClick={() => setReadiness(active ? null : opt.value)}
                      className={`flex h-11 w-11 items-center justify-center rounded-md transition-[transform,background-color,color] active:scale-[0.97] sm:h-9 sm:w-9 ${
                        active ? opt.activeClass : "bg-[#ECEAE1] text-[#3D4A44]"
                      }`}
                    >
                      <Ico name={opt.icon} size={15} />
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) setPendingPhoto(file);
                  }}
                />
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  aria-label={pendingPhoto ? "Photo attached, tap to replace" : "Add a photo"}
                  className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border transition-[transform,background-color,color] active:scale-[0.97] ${
                    pendingPhoto
                      ? "border-[#14201B] bg-[#14201B] text-[#F7F6F1]"
                      : "border-[#E2DFD5] bg-transparent text-[#5B6560]"
                  }`}
                >
                  <Ico name="camera" size={17} />
                </button>
                <span className="min-h-[1em] text-[12px] leading-relaxed text-[#8A6D2F]">
                  {photoUiState === "uploading" && "Attaching photo"}
                  {photoUiState === "error" && "Photo failed to attach."}
                  {photoUiState === "idle" && pendingPhoto && "1 photo"}
                </span>
              </div>
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

      {error && <div className="mt-3 text-[13px] leading-relaxed text-[#8A6D2F]">{error}</div>}
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
  onMatched,
  onResolved,
}: {
  touchpointId: string;
  nameGuess: string | null;
  matchAccountId: string | null;
  matchAccountName: string | null;
  onMatched?: (accountId: string) => void;
  onResolved: () => void;
}) {
  const [matching, setMatching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [filed, setFiled] = useState<FiledResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(nameGuess ?? "");
  const [candidates, setCandidates] = useState<{ id: string; name: string; city: string | null }[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const key = useIdempotencyKey(touchpointId);

  useEffect(() => {
    if (!filed) return;
    const t = setTimeout(onResolved, 1200);
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
      const matchedId = (data.result?.accountId as string | undefined) ?? (body.accountId as string | undefined);
      if (matchedId) onMatched?.(matchedId);
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
    setSearchError(null);
    try {
      const res = await apiFetch(`/api/visit/search-accounts?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!data.ok) {
        setCandidates([]);
        setSearchError(data.error || "That search did not reach the server.");
        return;
      }
      setCandidates(data.candidates ?? []);
    } catch {
      setCandidates([]);
      setSearchError("That search did not reach the server.");
    } finally {
      setSearching(false);
      setSearched(true);
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
              className={`${primaryBtn} min-h-11 shrink-0 rounded-full px-3.5 py-1.5 text-[12px]`}
            >
              {matching ? <Spinner /> : "Yes"}
            </button>
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">Which account</div>
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearched(false);
              setSearchError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Business name"
            className={`${inputCls} min-w-0 flex-1`}
          />
          <button
            type="button"
            onClick={search}
            disabled={searching || !query.trim()}
            aria-label="Search"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[#14201B] text-[#F7F6F1] transition-transform active:scale-[0.97] disabled:opacity-40"
          >
            {searching ? <Spinner /> : <Ico name="search" size={16} />}
          </button>
        </div>

        {searchError && <div className="mt-2 text-[12px] text-[#8A6D2F]">{searchError}</div>}

        {candidates.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => pick(c)}
                disabled={matching}
                className="flex min-h-11 items-center gap-2 rounded-full border border-[#E2DFD5] bg-white py-1 pl-3 pr-1.5 text-[12.5px] text-[#14201B] transition-transform active:scale-[0.97] disabled:opacity-40"
              >
                {c.name}
                {c.city && <span className="text-[#8A928C]">· {c.city}</span>}
              </button>
            ))}
          </div>
        )}

        {searched && !searching && !searchError && candidates.length === 0 && (
          <div className="mt-2 text-[12px] text-[#8A928C]">No accounts matched.</div>
        )}

        {query.trim() && (
          <button
            type="button"
            onClick={createNew}
            disabled={creating}
            className={`${ghostBtn} mt-2 flex items-center gap-1.5`}
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
    const t = setTimeout(onResolved, 1200);
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
        />
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[#E2DFD5] bg-[#FAF9F5] p-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-[#8A928C]">
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
        <button type="button" onClick={() => submit("No follow-up needed.")} disabled={pending} className={ghostBtn}>
          None needed
        </button>
        <button
          type="button"
          onClick={() => submit(text)}
          disabled={pending || !text.trim()}
          className={`${primaryBtn} flex items-center gap-1.5`}
        >
          {pending && <Spinner />}
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
    return <div className="text-[13px] text-[#8A6D2F]">Could not load the review queue.</div>;
  }
  if (pending === null || pendingNextSteps === null) {
    return (
      <div className="flex flex-col gap-3">
        <SkeletonBar className="h-4 w-32" />
        <SkeletonBar className="h-24 w-full" />
        <SkeletonBar className="h-24 w-full" />
      </div>
    );
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
