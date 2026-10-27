"use client";

/**
 * Small pieces the Prospect dashboard shares: channel and social glyphs in
 * the house stroke style (Ico's 16px grid, 1.4 stroke), plain-date helpers,
 * the press feedback classes, and the open-the-account event.
 */
import type { ReactNode } from "react";
import { Ico } from "../../../lib/core/ui";
import { RANKED_VIEW_EVENT } from "../../../lib/features/prospect/events";
import type { IntelChannel, IntelRanked } from "../../../lib/features/prospect/intel";

/* ------------------------------------------------------------------ */
/* Glyphs                                                              */
/* ------------------------------------------------------------------ */

const EXTRA: Record<string, ReactNode> = {
  text: (
    <>
      <path d="M3.2 3h9.6c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H8L5 13.4v-2.6H3.2c-.7 0-1.2-.5-1.2-1.2V4.2C2 3.5 2.5 3 3.2 3Z" />
    </>
  ),
  sample: (
    <>
      <path d="m8 2.2 5.2 2.4v6.8L8 13.8l-5.2-2.4V4.6L8 2.2Z" />
      <path d="m2.8 4.6 5.2 2.4 5.2-2.4M8 7v6.8" />
    </>
  ),
  linkedin: (
    <>
      <rect x="2.2" y="2.2" width="11.6" height="11.6" rx="2" />
      <path d="M5.4 7v3.6M5.4 5.3v.01M7.9 10.6V7m0 1.6c0-1 .7-1.7 1.6-1.7s1.5.7 1.5 1.7v2" />
    </>
  ),
  instagram: (
    <>
      <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="3.2" />
      <circle cx="8" cy="8" r="2.5" />
      <path d="M11.2 4.8v.01" />
    </>
  ),
  facebook: <path d="M9.4 14V8.6h1.8l.3-2.1H9.4V5.3c0-.6.2-1 1-1h1.2V2.4c-.2 0-.9-.1-1.7-.1-1.7 0-2.8 1-2.8 2.9v1.3H5.2v2.1h1.9V14" />,
  check: <path d="m3 8.4 3.2 3.2L13 4.8" />,
};

/** Any icon the dashboard needs: Ico's own set first, the extras here second. */
export function Glyph({ name, size = 16 }: { name: string; size?: number }) {
  const extra = EXTRA[name];
  if (!extra) return <Ico name={name} size={size} />;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {extra}
    </svg>
  );
}

const CHANNEL_GLYPH: Record<IntelChannel["key"], string> = {
  in_person: "pin",
  call: "phone",
  email: "mail",
  text: "text",
  linkedin: "linkedin",
  sample: "sample",
};
const CHANNEL_NAME: Record<IntelChannel["key"], string> = {
  in_person: "In person",
  call: "Call",
  email: "Email",
  text: "Text",
  linkedin: "LinkedIn",
  sample: "Samples",
};
export const channelGlyph = (k: IntelChannel["key"]) => CHANNEL_GLYPH[k] ?? "dot";
export const channelName = (k: IntelChannel["key"]) => CHANNEL_NAME[k] ?? k;

const FOLLOWUP_GLYPH: Record<string, string> = { call: "phone", visit: "pin", email: "mail", callback: "phone-arrow" };
export const followupGlyph = (k: string) => FOLLOWUP_GLYPH[k] ?? "clock";

/* ------------------------------------------------------------------ */
/* Press feedback                                                      */
/* ------------------------------------------------------------------ */

/** Instant tint and a small scale on press; both gone for reduced motion. */
export const pressCls =
  "touch-manipulation transition-[transform,background-color] duration-100 ease-out active:bg-[#F1EFE7] active:scale-[0.985] motion-reduce:transition-none motion-reduce:active:scale-100";

/* ------------------------------------------------------------------ */
/* Dates, plain form                                                   */
/* ------------------------------------------------------------------ */

const MS_DAY = 86_400_000;

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function monthDay(d: Date, withYear: boolean): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}) });
}

/** "today", "yesterday", "3 days ago", else "Oct 19". Past dates only. */
export function plainPast(input: string | Date | null | undefined): string | null {
  if (!input) return null;
  const d = typeof input === "string" ? (input.length === 10 ? new Date(`${input}T12:00:00`) : new Date(input)) : input;
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const diff = Math.round((localMidnight(now) - localMidnight(d)) / MS_DAY);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return `${diff} days ago`;
  return monthDay(d, d.getFullYear() !== now.getFullYear());
}

/** "today", "tomorrow", "Oct 30", for a date that may be ahead. */
export function plainAhead(iso: string): string | null {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Math.round((localMidnight(d) - localMidnight(new Date())) / MS_DAY);
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  if (diff === -1) return "yesterday";
  return monthDay(d, d.getFullYear() !== new Date().getFullYear());
}

/** "1 day ago" style from a count of days. */
export function daysAgo(n: number): string {
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  return `${n} days ago`;
}

/* ------------------------------------------------------------------ */
/* Opening an account in the call list                                 */
/* ------------------------------------------------------------------ */

export function openAccount(row: IntelRanked): void {
  window.dispatchEvent(new CustomEvent(RANKED_VIEW_EVENT, { detail: row }));
}

/** The detail for an account that is not a ranked row. */
export function unrankedRow(id: string, name: string): IntelRanked {
  return { id, name, area: null, score: null, reason: "", band: "unscored" };
}

/* ------------------------------------------------------------------ */
/* Bits                                                                */
/* ------------------------------------------------------------------ */

export function ColumnTitle({ title, count, aside }: { title: string; count?: number | null; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex min-h-6 items-baseline justify-between gap-3">
      <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#14201B]">
        {title}
        {count != null && <span className="ml-1.5 font-normal text-[#8A928C] [font-variant-numeric:tabular-nums]">{count}</span>}
      </h2>
      {aside}
    </div>
  );
}

export function SubTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <h3 className="text-[13px] font-medium text-[#5B6560]">{children}</h3>
      {aside}
    </div>
  );
}

/** Show a few rows, the rest one tap away. */
export function MoreToggle({ open, hidden, onToggle }: { open: boolean; hidden: number; onToggle: () => void }) {
  if (hidden <= 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`mt-1 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md text-[13.5px] font-medium text-[#5B6560] ${pressCls}`}
    >
      {open ? "Show fewer" : `Show ${hidden} more`}
      <Ico name={open ? "chevron-up" : "chevron-down"} size={13} />
    </button>
  );
}

export const rowDivider = "border-t border-[#EDEBE3] first:border-t-0";

/** Only http(s) links are opened from data. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  return /^https?:\/\//i.test(u) ? u : null;
}
