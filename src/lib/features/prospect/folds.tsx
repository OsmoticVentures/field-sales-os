"use client";

/**
 * Folds for the SDR view. Every group (a day, a High/Med/Low tier, each
 * section of the account panel) opens and closes with one tap, and stays
 * the way it was left on this phone until tapped again.
 *
 * One localStorage key holds the set of closed folds. Bounded: day folds
 * for dates before today are pruned on every write, and the set never
 * keeps more than MAX_KEYS entries (oldest dropped first).
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { Ico } from "../../core/ui";

const KEY = "nb_sdr_folds";
const MAX_KEYS = 200;
const EMPTY: readonly string[] = [];

let cache: readonly string[] | null = null;
const listeners = new Set<() => void>();

function read(): readonly string[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    cache = Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    cache = [];
  }
  return cache;
}

function laToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function write(next: string[]) {
  const today = laToday();
  // A day fold is keyed "day:YYYY-MM-DD" (or "day:YYYY-MM-DD:tier"); once
  // the date is past it can never show again, so it goes.
  const kept = next.filter((k) => !k.startsWith("day:") || k.slice(4, 14) >= today).slice(-MAX_KEYS);
  cache = kept;
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Private mode or full storage: the fold still works for this visit.
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null;
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}

/** True when the fold `id` is closed. Open in the server HTML. */
export function useFolded(id: string): [boolean, () => void] {
  const closed = useSyncExternalStore(subscribe, read, () => EMPTY);
  const folded = closed.includes(id);
  const toggle = () => {
    const now = read();
    write(folded ? now.filter((k) => k !== id) : [...now.filter((k) => k !== id), id]);
  };
  return [folded, toggle];
}

/** The body of a fold: stays mounted (so a half-typed field survives a
 *  close), animates its height, and is inert while closed. */
export function FoldBody({ folded, children }: { folded: boolean; children: ReactNode }) {
  return (
    <div
      className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${folded ? "grid-rows-[0fr]" : "grid-rows-[1fr]"}`}
      inert={folded}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** A tappable header row: label left, optional count and a chevron right. */
export function FoldHeader({
  folded,
  onToggle,
  children,
  count,
  className = "",
}: {
  folded: boolean;
  onToggle: () => void;
  children: ReactNode;
  count?: number;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!folded}
      className={`flex min-h-11 w-full items-center justify-between gap-2 text-left ${className}`}
    >
      <span className="min-w-0">{children}</span>
      <span className="flex shrink-0 items-center gap-2 text-[#8A928C]">
        {count != null && <span className="tabular-nums">{count}</span>}
        <span className={`inline-flex transition-transform duration-200 motion-reduce:transition-none ${folded ? "-rotate-90" : ""}`}>
          <Ico name="chevron-down" size={14} />
        </span>
      </span>
    </button>
  );
}

/** A panel section: the small label as its header, the content below. */
export function FoldSection({
  id,
  label,
  className = "mt-3 border-t border-[#E2DFD5] pt-1",
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const [folded, toggle] = useFolded(`panel:${id}`);
  return (
    <div className={className}>
      <FoldHeader folded={folded} onToggle={toggle} className="text-[11.5px] tracking-[0.1em] text-[#8A928C] uppercase">
        {label}
      </FoldHeader>
      <FoldBody folded={folded}>
        <div className="pb-1">{children}</div>
      </FoldBody>
    </div>
  );
}
