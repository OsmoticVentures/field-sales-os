"use client";

/**
 * Visit Logger's client UI: the capture box and the outbox under it. Log
 * saves the note on the phone and clears the box at once; the outbox
 * (lib/core/outbox.ts) files it in the background, retrying until HubSpot
 * confirms, through no signal, a closed app or a crash. Until then the note
 * stays listed under the composer with where it stands, so nothing is ever
 * believed filed that is not. A note whose store could not be told waits in
 * that list with the closest accounts as one-tap picks. A store New company
 * created waits there, filed, for its type.
 * Ported and trimmed from portfolio/src/app/nutribiotic/lib/touchpoint-ui.tsx
 * and new-account-ui.tsx.
 */

import { useEffect, useRef, useState } from "react";
import { Geolocation } from "@capacitor/geolocation";
import {
  chooseType,
  discard,
  enqueue,
  fileTo,
  outboxLabel,
  runOutbox,
  takeBack,
  useOutbox,
  type OutboxItem,
} from "../../core/outbox";
import { waitsForType, type AccountPick, type NeedsAccount } from "../../core/outbox-core";
import { Ico, ghostBtn } from "../../core/ui";

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

const STORE_TYPE_OPTIONS = [
  { value: "grocery", label: "Grocery" },
  { value: "specialty", label: "Specialty" },
  { value: "pharmacy", label: "Pharmacy" },
  { value: "clinic", label: "Clinic" },
  { value: "spa_beauty", label: "Spa and beauty" },
  { value: "gym", label: "Gym" },
  { value: "pet_specialty", label: "Pet" },
] as const;

type Readiness = "urgent" | "hot" | "normal" | "cold";
const READINESS_OPTIONS: { value: Readiness; icon: string; title: string; activeClass: string }[] = [
  { value: "urgent", icon: "urgent", title: "Urgent, ready now, +20 to priority", activeClass: "bg-[#9C4A44] text-[#F7F6F1]" },
  { value: "hot", icon: "hot", title: "Hot, close, +10 to priority", activeClass: "bg-[#A8703D] text-[#F7F6F1]" },
  { value: "normal", icon: "dot", title: "Normal, no change to priority", activeClass: "bg-[#14201B] text-[#F7F6F1]" },
  { value: "cold", icon: "snowflake", title: "Cold, not close, -10 to priority", activeClass: "bg-[#5C7E8C] text-[#F7F6F1]" },
];

// ---------------------------------------------------------------------------
// the capture box
// ---------------------------------------------------------------------------

export function TouchpointCapture({
  accountIdHint,
  accountName,
  onFiled,
  defaultKind,
  initialText,
  autoFocus = true,
}: {
  /** The account the note is about, when the caller already knows it (the
   *  prospect view, a client's Log a visit). Skips matching; the note files
   *  straight to it. */
  accountIdHint?: string | null;
  /** That account's name, so the outbox line reads right before it files. */
  accountName?: string | null;
  /** Fires once the note is saved on the phone. Filing follows in the outbox. */
  onFiled?: () => void;
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The confirmation beat: on the disk, or only for as long as the app is open.
  const [saved, setSaved] = useState<{ durable: boolean } | null>(null);
  const [grade, setGrade] = useState<VisitGrade | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [newCompany, setNewCompany] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Where the phone is, so a new store is found at this door, not across town.
  const nearRef = useRef<{ lat: number; lng: number } | null>(null);

  function locate() {
    Geolocation.getCurrentPosition({ timeout: 8000, maximumAge: 300_000 })
      .then((pos) => {
        nearRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      })
      .catch(() => {});
  }

  useEffect(() => {
    if (!accountIdHint) locate();
  }, [accountIdHint]);

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
    if (!saved) return;
    const t = setTimeout(() => setSaved(null), saved.durable ? 1200 : 4000);
    return () => clearTimeout(t);
  }, [saved]);

  function autosize(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
  }

  function refocus() {
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        autosize(textareaRef.current);
        if (autoFocus) textareaRef.current.focus({ preventScroll: true });
      }
    });
  }

  function reset() {
    setText("");
    setKind(defaultKind ?? "meeting");
    setKindTouched(Boolean(defaultKind));
    setGrade(null);
    setReadiness(null);
    setNewCompany(false);
    setPendingPhoto(null);
    refocus();
  }

  /** Save on the phone, clear the box, file in the background. */
  async function submit() {
    const value = text;
    if (!value.trim() || saving) return;
    const note = {
      text: value,
      accountIdHint: accountIdHint ?? null,
      accountName: accountName ?? null,
      kind: kindTouched ? kind : null,
      newCompany,
      grade,
      readiness,
      photoFile: pendingPhoto,
      near: newCompany ? nearRef.current : null,
    };
    const was = { kind, kindTouched };
    setSaving(true);
    setError(null);
    setSaved(null);
    reset();
    try {
      const r = await enqueue(note);
      setSaved({ durable: r.durable });
      onFiled?.();
    } catch {
      // Nothing was kept: the note goes back on the screen, as typed.
      setText(note.text);
      setKind(was.kind);
      setKindTouched(was.kindTouched);
      setGrade(note.grade);
      setReadiness(note.readiness);
      setNewCompany(note.newCompany);
      setPendingPhoto(note.photoFile);
      setError("Couldn't save that note on the phone. Try again.");
      refocus();
    } finally {
      setSaving(false);
    }
  }

  /** An unfiled note tapped back from the outbox, to fix and log again. */
  function restore(it: OutboxItem) {
    setText(it.text);
    setKind(it.kind ?? defaultKind ?? "meeting");
    setKindTouched(Boolean(it.kind ?? defaultKind));
    setGrade((it.grade as VisitGrade | null) ?? null);
    setReadiness((it.readiness as Readiness | null) ?? null);
    setNewCompany(it.newCompany);
    setPendingPhoto(it.photo ? new File([it.photo.bytes], it.photo.name || "photo.jpg", { type: it.photo.type }) : null);
    setError(null);
    refocus();
  }

  return (
    <div className="w-full">
      <div className="rounded-xl border border-[#E2DFD5] bg-white p-4 sm:p-5">
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
            if (error) setError(null);
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
              onClick={() => {
                if (!newCompany) locate();
                setNewCompany((v) => !v);
              }}
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
            <span className="min-h-[1em] text-[12px] leading-relaxed text-[#8A6D2F]">{pendingPhoto && "1 photo"}</span>
          </div>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={saving || !text.trim()}
            aria-label="Log this note"
            className="flex h-11 shrink-0 items-center gap-2 rounded-full bg-[#14201B] px-6 text-[14.5px] font-medium text-[#F7F6F1] transition-[transform,opacity] active:scale-[0.97] disabled:opacity-30"
          >
            <Ico name="send" size={17} />
            Log
          </button>
        </div>

        {saved && (
          <div role="status" className="mt-3 flex items-center gap-1.5 text-[13px] font-medium text-[#2C6A46]">
            <Ico name="check" size={13} />
            {saved.durable ? "Saved" : "Saved until the app closes"}
          </div>
        )}
        {error && <ErrorLine message={error} picks={[]} busy={false} onPick={() => {}} onRetry={null} />}
      </div>

      <OutboxList onTakeBack={restore} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// the outbox under the composer
// ---------------------------------------------------------------------------

/** Where an unconfirmed note stands, in one or two words. */
function standing(it: OutboxItem, running: boolean): { word: string; alert: boolean } {
  if (waitsForType(it)) return { word: "Filed, pick its type", alert: false };
  if (it.parked === "needs-account") return { word: "Needs a store", alert: true };
  if (it.parked === "rejected") return { word: "Not filed", alert: true };
  if (!it.filed) {
    if (running || it.attempts === 0) return { word: "Saving", alert: false };
    return { word: it.offline ? "No connection, retrying" : "Retrying", alert: false };
  }
  if (it.hubspot === "pending") {
    if (it.hubspotRefused) return { word: "Filed, HubSpot refused it", alert: true };
    if (it.offline && !running) return { word: "Filed, no connection, retrying", alert: false };
    return { word: "Filed, waiting for HubSpot", alert: false };
  }
  if (!it.photoDone) return { word: "Filed, photo pending", alert: false };
  return { word: "Filed", alert: false };
}

/** Stuck enough that letting it go is his call: parked, refused, or still
 *  failing after a few rounds. */
const discardable = (it: OutboxItem) => Boolean(it.parked) || Boolean(it.hubspotRefused) || it.attempts >= 3;

function OutboxList({ onTakeBack }: { onTakeBack: (it: OutboxItem) => void }) {
  const { items, done, running } = useOutbox();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [trying, setTrying] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  if (items.length === 0 && done.length === 0) return null;

  const lineCls = "flex min-h-11 items-center justify-between gap-3 text-[13px]";

  return (
    <div className="mt-3 flex flex-col divide-y divide-[#EDEBE3] rounded-xl border border-[#E2DFD5] bg-[#FAF9F5] px-4">
      {done.map((d) => (
        <div key={d.id} role="status" className={lineCls}>
          <span className="min-w-0 truncate text-[#3D4A44]">{d.label}</span>
          <span className="flex shrink-0 items-center gap-1.5 font-medium text-[#2C6A46]">
            <Ico name="check" size={13} />
            {d.hubspot === "done" ? "Filed to HubSpot" : d.hubspot === "off" ? "Filed, CRM filing off" : "Filed"}
          </span>
        </div>
      ))}

      {items.map((it) => {
        const s = standing(it, running === it.id);
        return (
          <div key={it.id} className="py-1">
            <div className={lineCls}>
              <span className="min-w-0 truncate text-[#3D4A44]">{outboxLabel(it)}</span>
              <span className={`flex shrink-0 items-center gap-1.5 ${s.alert ? "font-medium text-[#8A2E2E]" : "text-[#8A928C]"}`}>
                {running === it.id && <Spinner light={false} />}
                {s.word}
              </span>
            </div>
            {it.parked && it.lastError && (
              <ErrorLine
                message={it.lastError}
                picks={it.needsAccount ? pickList(it.needsAccount) : []}
                busy={running === it.id}
                onPick={(a) => void fileTo(it.id, a)}
                onRetry={null}
              />
            )}
            {waitsForType(it) && (
              <div className="flex flex-wrap gap-1.5 pb-2">
                {STORE_TYPE_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => void chooseType(it.id, o.value)}
                    className={`inline-flex min-h-11 items-center rounded-full border px-3.5 text-[13px] font-medium transition-transform active:scale-[0.97] ${
                      it.storeType?.suggested === o.value ? "border-[#14201B] text-[#14201B]" : "border-[#E2DFD5] text-[#5B6560]"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => void chooseType(it.id, null)}
                  className="inline-flex min-h-11 items-center rounded-full border border-[#E2DFD5] px-3.5 text-[13px] font-medium text-[#5B6560] transition-transform active:scale-[0.97]"
                >
                  Other
                </button>
              </div>
            )}
            {discardable(it) && (
              <div className="flex justify-end gap-1">
                {!it.filed && running !== it.id && (
                  <button
                    type="button"
                    onClick={async () => {
                      const back = await takeBack(it.id);
                      if (back) onTakeBack(back);
                    }}
                    className="inline-flex min-h-11 items-center gap-1.5 px-2 text-[13px] text-[#5B6560]"
                  >
                    <Ico name="edit" size={13} />
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (confirming === it.id) {
                      setConfirming(null);
                      void discard(it.id);
                    } else setConfirming(it.id);
                  }}
                  className={`inline-flex min-h-11 items-center gap-1.5 px-2 text-[13px] ${
                    confirming === it.id ? "font-medium text-[#8A2E2E]" : "text-[#5B6560]"
                  }`}
                >
                  <Ico name="close" size={13} />
                  {confirming === it.id ? "Confirm discard" : "Discard"}
                </button>
              </div>
            )}
          </div>
        );
      })}

      {items.length > 0 && (
        <div className="flex justify-end py-1">
          <button
            type="button"
            disabled={trying}
            onClick={async () => {
              setTrying(true);
              await runOutbox(true);
              setTrying(false);
            }}
            className={`${ghostBtn} flex items-center gap-1.5`}
          >
            {trying && <Spinner light={false} />}
            Try now
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the error line under the composer
// ---------------------------------------------------------------------------

/** The best match first, then the rest of the closest accounts, three at most. */
function pickList(u: NeedsAccount): AccountPick[] {
  const best = u.matchAccountId && u.matchAccountName ? [{ id: u.matchAccountId, name: u.matchAccountName, city: null }] : [];
  return [...best, ...u.candidates.filter((c) => c.id !== u.matchAccountId)].slice(0, 3);
}

function ErrorLine({
  message,
  picks,
  busy,
  onPick,
  onRetry,
}: {
  message: string;
  picks: AccountPick[];
  busy: boolean;
  onPick: (a: { id: string; name: string }) => void;
  onRetry: (() => void) | null;
}) {
  return (
    <div role="alert" className="mt-3 text-[13.5px] leading-relaxed font-medium text-[#8A2E2E]">
      <span>{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={busy}
          className="ml-1.5 inline-flex min-h-11 items-center gap-1.5 underline underline-offset-2 disabled:opacity-50"
        >
          {busy && <Spinner light={false} />}
          Try again
        </button>
      )}
      {picks.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {picks.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick(c)}
              disabled={busy}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-[#D9B8B3] px-3.5 text-[13px] font-medium text-[#8A2E2E] transition-transform active:scale-[0.97] disabled:opacity-50"
            >
              {c.name}
              {c.city && <span className="font-normal opacity-70">{c.city}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
