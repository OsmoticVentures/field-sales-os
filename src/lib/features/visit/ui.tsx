"use client";

/**
 * Visit Logger's client UI: the capture box and, when the note's store is not
 * named with confidence, the account pick right inside it. A note is either
 * filed or still on the screen with its text; nothing is parked for later.
 * Ported and trimmed from portfolio/src/app/nutribiotic/lib/touchpoint-ui.tsx
 * and new-account-ui.tsx.
 *
 * The Google-Places new-business search is replaced with a search of
 * Juan's own book (see search-accounts/route.ts). Every write goes through
 * apiFetch so it carries the /nb basePath, and every write that creates a
 * row carries its own Idempotency-Key, generated once per attempt and
 * reused on any retry of that same attempt, per PORTING.md.
 */

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { apiFetch } from "../../core/api";
import { Ico, ghostBtn, inputCls, primaryBtn } from "../../core/ui";

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

// ---------------------------------------------------------------------------
// types mirrored from the route handlers' JSON shapes
// ---------------------------------------------------------------------------

type FiledResult = {
  ok: true;
  touchpoint_id: string;
  accountName: string | null;
  accountId: string | null;
  activityId: number | null;
  needsAccount: false;
  isFieldNote?: boolean;
  summary: string;
  peopleAdded: number;
  peopleUpdated: number;
  hubspotFiled: boolean;
  hubspotNoteId: string | null;
  hubspotError: string | null;
};

type AccountOption = { id: string; name: string; city: string | null };

type NeedsAccountResult = {
  ok: true;
  needsAccount: true;
  summary: string;
  businessNameGuess: string | null;
  matchAccountId: string | null;
  matchAccountName: string | null;
  candidates: AccountOption[];
  parsed: unknown;
};

type TouchpointApiResult = FiledResult | NeedsAccountResult;

/** A HubSpot miss worth a retry: anything but the deliberate off switch. */
const hubspotFailed = (r: FiledResult) => !r.isFieldNote && !r.hubspotFiled && r.hubspotError !== "CRM filing off";

/** POST JSON, answer the parsed body, or throw a short readable reason. */
async function postJson<T>(path: string, body: unknown, key?: string): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("No connection. Nothing was filed.");
  }
  const data = await res.json().catch(() => null);
  if (!data?.ok) throw new Error(data?.error || `Server error ${res.status}. Nothing was filed.`);
  return data.result as T;
}

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

export function TouchpointCapture({
  accountIdHint,
  onFiled,
  defaultKind,
  initialText,
  autoFocus = true,
}: {
  /** The account the note is about, when the caller already knows it (the
   *  prospect view). Skips matching; the note files straight to it. */
  accountIdHint?: string | null;
  /** Fires once, after a clean file. Never on the pick or error paths. */
  onFiled?: (result: FiledResult) => void;
  /** Pre-selects a kind and sends it even if no pill is tapped. */
  defaultKind?: KindOption;
  /** Pre-typed opening, caret at the end. Applied once, on mount. */
  initialText?: string;
  /** False on a phone where landing here is not yet the intent to type. */
  autoFocus?: boolean;
} = {}) {
  const [text, setText] = useState(initialText ?? "");
  const [kind, setKind] = useState<KindOption>(defaultKind ?? "meeting");
  const [kindTouched, setKindTouched] = useState(Boolean(defaultKind));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<FiledResult | null>(null);
  const [choose, setChoose] = useState<NeedsAccountResult | null>(null);
  const [grade, setGrade] = useState<VisitGrade | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [newCompany, setNewCompany] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [photoUiState, setPhotoUiState] = useState<"idle" | "uploading" | "error">("idle");
  const [retryHubspot, setRetryHubspot] = useState<"idle" | "working">("idle");
  const photoInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // One key per note. A retry of the same note reuses it, so a write that
  // did land is never made twice; a filed note gets a fresh one.
  const key = useRef<string>("");
  if (!key.current) key.current = crypto.randomUUID();
  // The last thing tried, so a failure is one tap from running again.
  const lastTry = useRef<(() => void) | null>(null);

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
    }
  }

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
    if (initialText) el.setSelectionRange(initialText.length, initialText.length);
    if (autoFocus) el.focus({ preventScroll: true });
    // Mount only: a template is applied once, never over what he typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // A clean file clears itself; a HubSpot miss stays until it is retried
    // or dismissed, so it is never missed.
    if (!success || hubspotFailed(success)) return;
    const t = setTimeout(() => setSuccess(null), 1200);
    return () => clearTimeout(t);
  }, [success]);

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
  }

  function reset() {
    setText("");
    setKind(defaultKind ?? "meeting");
    setKindTouched(Boolean(defaultKind));
    setGrade(null);
    setReadiness(null);
    setNewCompany(false);
    setChoose(null);
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        autosize(textareaRef.current);
        if (autoFocus) textareaRef.current.focus({ preventScroll: true });
      }
    });
  }

  function filed(result: FiledResult) {
    if (pendingPhoto && result.touchpoint_id) void attachPhoto(result.touchpoint_id, pendingPhoto);
    setPendingPhoto(null);
    applyAccountRead(result.accountId, grade, readiness);
    key.current = crypto.randomUUID();
    lastTry.current = null;
    setSuccess(result);
    onFiled?.(result);
    reset();
  }

  function run(attempt: () => Promise<void>) {
    lastTry.current = () => run(attempt);
    startTransition(async () => {
      setError(null);
      try {
        await attempt();
      } catch (e) {
        setError(e instanceof Error ? e.message : "That note did not file.");
      }
    });
  }

  const kindOverride = () => (kindTouched ? kind : undefined);

  function submit() {
    const value = text;
    if (!value.trim() || pending) return;
    run(async () => {
      const result = await postJson<TouchpointApiResult>(
        "/api/visit/touchpoint",
        { text: value, accountIdHint: accountIdHint ?? undefined, kindOverride: kindOverride(), forceNewAccount: newCompany },
        key.current,
      );
      if (result.needsAccount) setChoose(result);
      else filed(result);
    });
  }

  function fileTo(account: { id: string; name: string }) {
    const pick = choose;
    if (!pick || pending) return;
    run(async () => {
      const result = await postJson<TouchpointApiResult>(
        "/api/visit/touchpoint",
        { text, accountIdHint: account.id, kindOverride: kindOverride(), parsed: pick.parsed },
        `${key.current}:${account.id}`,
      );
      if (result.needsAccount) throw new Error("That account did not take. Pick it again.");
      filed(result);
    });
  }

  function createAndFile(name: string) {
    const pick = choose;
    if (!pick || pending || !name.trim()) return;
    run(async () => {
      const made = await postJson<{ accountId: string; accountName: string }>(
        "/api/visit/new-account",
        { name: name.trim() },
        `${key.current}:new:${name.trim().toLowerCase()}`,
      );
      const result = await postJson<TouchpointApiResult>(
        "/api/visit/touchpoint",
        { text, accountIdHint: made.accountId, kindOverride: kindOverride(), parsed: pick.parsed },
        `${key.current}:${made.accountId}`,
      );
      if (result.needsAccount) throw new Error(`${made.accountName} was created but the note did not file to it. Pick it from the search.`);
      filed(result);
    });
  }

  function refileHubspot(result: FiledResult) {
    if (!result.activityId || retryHubspot === "working") return;
    setRetryHubspot("working");
    postJson<{ hubspotFiled: boolean; hubspotNoteId: string | null; hubspotError: string | null }>("/api/visit/refile", {
      activityId: result.activityId,
    })
      .then((r) => setSuccess({ ...result, ...r }))
      .catch((e: unknown) => setSuccess({ ...result, hubspotError: e instanceof Error ? e.message : "Still not filed to HubSpot." }))
      .finally(() => setRetryHubspot("idle"));
  }

  return (
    <div className="w-full">
      <div className="rounded-xl border border-[#E2DFD5] bg-white p-4 sm:p-5">
        {success ? (
          <div className="flex flex-col gap-2">
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
            {hubspotFailed(success) && success.activityId && (
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setSuccess(null)} className={ghostBtn}>
                  Close
                </button>
                <button
                  type="button"
                  onClick={() => refileHubspot(success)}
                  disabled={retryHubspot === "working"}
                  className={`${primaryBtn} flex items-center gap-1.5`}
                >
                  {retryHubspot === "working" && <Spinner />}
                  Retry HubSpot
                </button>
              </div>
            )}
          </div>
        ) : choose ? (
          <AccountPicker
            summary={choose.summary}
            nameGuess={choose.businessNameGuess}
            match={choose.matchAccountId && choose.matchAccountName ? { id: choose.matchAccountId, name: choose.matchAccountName } : null}
            initialCandidates={choose.candidates}
            busy={pending}
            onPick={fileTo}
            onCreate={createAndFile}
            onBack={() => {
              setChoose(null);
              setError(null);
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
              autoFocus={autoFocus}
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
                {!accountIdHint && <button
                  type="button"
                  aria-pressed={newCompany}
                  onClick={() => setNewCompany((v) => !v)}
                  title="Skip matching against your accounts"
                  className={`flex h-11 items-center gap-1.5 shrink-0 rounded-full border px-4 text-[12.5px] font-medium transition-[transform,background-color,color] active:scale-[0.97] ${
                    newCompany
                      ? "border-[#14201B] bg-[#14201B] text-[#F7F6F1]"
                      : "border-[#E2DFD5] bg-transparent text-[#5B6560]"
                  }`}
                >
                  <Ico name={newCompany ? "check" : "plus"} size={13} />
                  New company
                </button>}
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

      {error && (
        <div role="alert" className="mt-3 flex items-start justify-between gap-3 rounded-md border border-[#D9B8B3] bg-[#FBF1EF] px-3 py-2.5">
          <div className="flex min-w-0 items-start gap-1.5 text-[13.5px] leading-relaxed font-medium text-[#8A2E2E]">
            <Ico name="alert" size={14} />
            <span>{error}</span>
          </div>
          {lastTry.current && (
            <button
              type="button"
              onClick={() => lastTry.current?.()}
              disabled={pending}
              className="flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-[#8A2E2E] px-4 text-[13px] font-medium text-white transition-transform active:scale-[0.97] disabled:opacity-50"
            >
              {pending && <Spinner />}
              Try again
            </button>
          )}
        </div>
      )}
      {photoUiState === "error" && (
        <div role="alert" className="mt-2 text-[13px] font-medium text-[#8A2E2E]">
          The note filed, the photo did not attach.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the account pick, inside the capture box
// ---------------------------------------------------------------------------

function AccountPicker({
  summary,
  nameGuess,
  match,
  initialCandidates,
  busy,
  onPick,
  onCreate,
  onBack,
}: {
  summary: string;
  nameGuess: string | null;
  match: { id: string; name: string } | null;
  initialCandidates: AccountOption[];
  busy: boolean;
  onPick: (a: { id: string; name: string }) => void;
  onCreate: (name: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState(nameGuess ?? "");
  const [candidates, setCandidates] = useState<AccountOption[]>(initialCandidates);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(initialCandidates.length > 0 || Boolean(nameGuess));
  const [searchError, setSearchError] = useState<string | null>(null);

  async function search() {
    if (!query.trim() || searching) return;
    setSearching(true);
    setSearchError(null);
    try {
      const res = await apiFetch(`/api/visit/search-accounts?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Search failed.");
      setCandidates(data.candidates ?? []);
    } catch {
      setCandidates([]);
      setSearchError("Search failed. Check the connection and search again.");
    } finally {
      setSearching(false);
      setSearched(true);
    }
  }

  const options = match ? [match as AccountOption, ...candidates.filter((c) => c.id !== match.id)] : candidates;

  return (
    <div className="flex flex-col gap-3">
      <p className="line-clamp-3 text-[13.5px] leading-relaxed text-[#3D4A44]">{summary}</p>

      <div className="text-[15px] font-semibold text-[#14201B]">Which account?</div>

      {options.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {options.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c)}
              disabled={busy}
              className="flex min-h-12 w-full items-center justify-between gap-3 rounded-md border border-[#E2DFD5] bg-[#FAF9F5] px-3.5 text-left text-[14px] text-[#14201B] transition-transform active:scale-[0.99] disabled:opacity-50"
            >
              <span className="min-w-0 truncate font-medium">{c.name}</span>
              {c.city && <span className="shrink-0 text-[12.5px] text-[#8A928C]">{c.city}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
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

      {searchError && <div className="text-[13px] font-medium text-[#8A2E2E]">{searchError}</div>}
      {searched && !searching && !searchError && options.length === 0 && (
        <div className="text-[13px] text-[#5B6560]">Not in your book.</div>
      )}

      <div className="flex items-center justify-between gap-2">
        <button type="button" onClick={onBack} disabled={busy} className={ghostBtn}>
          Back
        </button>
        {query.trim() && (
          <button
            type="button"
            onClick={() => onCreate(query)}
            disabled={busy}
            className={`${primaryBtn} flex min-w-0 items-center gap-1.5`}
          >
            {busy ? <Spinner /> : <Ico name="plus" size={13} />}
            <span className="truncate">New: {query.trim()}</span>
          </button>
        )}
      </div>
    </div>
  );
}
