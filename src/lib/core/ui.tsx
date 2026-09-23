/**
 * Shared UI primitives, ported from the NutriBiotic OS design system
 * (portfolio/src/app/nutribiotic/lib/ui.tsx) with only what this port needs.
 * Same palette and tokens as the source; add an icon or a primitive here
 * when a later port needs one, don't paste the whole source file back in.
 *
 * House rules, agency-wide:
 *   - Editorial SVG icons only. Never an emoji. Never a spark/sparkle/star.
 *   - No em dashes in any UI copy.
 *   - One accent; signals live in labels, not a rainbow of colors.
 *   - Every one-tap confirm ends in SuccessNote below, inline, in place.
 *
 * FIELD AND BUTTON SIZING IS SET ONCE, HERE. 16px input text (iOS Safari
 * zooms the viewport on focus below that) and a 44px minimum touch target,
 * every port inherits it by using these exports rather than its own ad hoc
 * classes. Press feedback and its `motion-reduce` fallback live here too,
 * so `prefers-reduced-motion` is handled once, not per port.
 */

import type { ReactNode } from "react";

export const inputCls =
  "w-full min-h-11 rounded-md border border-[#E2DFD5] bg-[#FAF9F5] px-3 py-2.5 text-[16px] text-[#14201B] placeholder:text-[#A9AFA9] focus:border-[#14201B] focus:outline-none";
/** Sentence case, no tracking: a field's own label, not a section head. Use
 *  eyebrowCls below for a card or section heading instead. */
export const labelCls = "mb-1 block text-[13px] text-[#5B6560]";
/** A section or card heading label. Reserve for that; a form field's own
 *  label uses labelCls (sentence case) instead. */
export const eyebrowCls = "text-[11px] uppercase tracking-[0.14em] text-[#8A928C]";
export const primaryBtn =
  "min-h-11 rounded-md bg-[#14201B] px-3.5 py-2.5 text-[14px] font-medium text-[#F7F6F1] transition-transform active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:opacity-40 disabled:active:scale-100";
export const ghostBtn =
  "min-h-11 rounded-md border border-[#E2DFD5] px-3 py-2.5 text-[14px] text-[#5B6560] transition-transform active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:opacity-40";

export const ICONS: Record<string, ReactNode> = {
  check: <path d="m3 8.4 3.2 3.2L13 4.8" />,
  alert: (
    <>
      <path d="M8 2.6 14.2 13H1.8L8 2.6Z" />
      <path d="M8 6.6v3M8 11.4h.01" />
    </>
  ),
  close: <path d="m3.6 3.6 8.8 8.8M12.4 3.6l-8.8 8.8" />,
  external: (
    <>
      <path d="M9 2.6h4.4V7" />
      <path d="M13.4 2.6 7.6 8.4" />
      <path d="M11.8 9.4v3.2c0 .5-.4.9-.9.9H3.4c-.5 0-.9-.4-.9-.9V5.1c0-.5.4-.9.9-.9h3.2" />
    </>
  ),
  camera: (
    <>
      <path d="M2.4 5.4h2.2l1-1.6h4.8l1 1.6h2.2v7.2H2.4z" />
      <circle cx="8" cy="9" r="2.3" />
    </>
  ),
  gauge: (
    <>
      <circle cx="8" cy="8.6" r="5.8" />
      <path d="M8 8.6 10.6 6M5.4 8.6h5.2" strokeLinecap="round" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.3 1.4" />
    </>
  ),
  plus: <path d="M8 2.8v10.4M2.8 8h10.4" />,
  "chevron-up": <path d="m4 10 4-4 4 4" />,
  "chevron-down": <path d="m4 6 4 4 4-4" />,
  pin: (
    <>
      <path d="M8 14s4.6-4.3 4.6-7.6A4.6 4.6 0 1 0 3.4 6.4C3.4 9.7 8 14 8 14Z" />
      <circle cx="8" cy="6.4" r="1.6" />
    </>
  ),
  search: (
    <>
      <circle cx="6.8" cy="6.8" r="4.2" />
      <path d="m13 13-3.4-3.4" />
    </>
  ),
  phone: <path d="M4 2.6h2.2l1 2.6-1.4 1.2a8 8 0 0 0 3.8 3.8l1.2-1.4 2.6 1V12a1.4 1.4 0 0 1-1.4 1.4C7.7 13.4 2.6 8.3 2.6 4A1.4 1.4 0 0 1 4 2.6Z" />,
  "phone-arrow": (
    <>
      <path d="M5.6 2.6H3.4c-.7 0-1.3.6-1.2 1.3.3 5.2 4.7 9.6 9.9 9.9.7.1 1.3-.5 1.3-1.2v-2.2l-2.8-.9-1.2 1.4a9.4 9.4 0 0 1-4.1-4.1l1.4-1.2z" />
      <path d="M9.8 2.6h3.6v3.6" />
      <path d="M13.4 2.6 9.6 6.4" />
    </>
  ),
  route: (
    <>
      <circle cx="3.6" cy="4" r="1.4" />
      <circle cx="12.4" cy="12" r="1.4" />
      <path d="M3.6 5.4v2.2A2.4 2.4 0 0 0 6 10h4a2.4 2.4 0 0 1 2.4 2.4" />
    </>
  ),
  wand: (
    <>
      <path d="m3 13 7-7" />
      <path d="M11 2.6v1.8M13.6 5.2h-1.8M8.6 2.6l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3Z" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M2.4 8h11.2M8 2.4a8.6 8.6 0 0 1 0 11.2M8 2.4a8.6 8.6 0 0 0 0 11.2" />
    </>
  ),
  mail: (
    <>
      <rect x="2" y="3.6" width="12" height="8.8" rx="1.2" />
      <path d="m2.6 4.4 5.4 4 5.4-4" />
    </>
  ),
  book: (
    <>
      <path d="M3 2.8h6.4a1.6 1.6 0 0 1 1.6 1.6V13H4.6A1.6 1.6 0 0 1 3 11.4V2.8Z" />
      <path d="M3 11.6h8" />
    </>
  ),
  edit: <path d="M9.6 3.2 12.8 6.4 5.6 13.6 2.4 14l.4-3.2Z" />,
  hubspot: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2.6v3.2M11.4 5.4 9 7M11.4 10.6 9 9M4.6 10.6 7 9M4.6 5.4 7 7" />
    </>
  ),
  send: <path d="M2 8 13.6 2.4 8.4 13.6l-1.6-4.4L2 8Zm4.8 1.2L11.2 4.8" />,
  chart: <path d="M2.6 13.4h10.8M4.4 11V7.4M8 11V4M11.6 11V8.6" />,
  fuel: (
    <>
      <path d="M3 13.4V3.8c0-.7.5-1.2 1.2-1.2h3.6c.7 0 1.2.5 1.2 1.2v9.6" />
      <path d="M2 13.4h8M4.4 4.8h3.2v2.8H4.4z" />
      <path d="M9 7.2h1.6c.6 0 1 .4 1 1v2.6a1.1 1.1 0 0 0 2.2 0V6.4L12 4.6" />
    </>
  ),
  urgent: <path d="M8 2.8v6.4M8 12.2h.01" strokeLinecap="round" />,
  hot: (
    <>
      <path d="M4.6 2.6c1.4 1.7-1.4 3.4 0 5.1c1.4 1.7-1.4 3.4 0 5.1" />
      <path d="M8 2.6c1.4 1.7-1.4 3.4 0 5.1c1.4 1.7-1.4 3.4 0 5.1" />
      <path d="M11.4 2.6c1.4 1.7-1.4 3.4 0 5.1c1.4 1.7-1.4 3.4 0 5.1" />
    </>
  ),
  dot: <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />,
  snowflake: (
    <>
      <path d="M1.3 8h13.4M8 1.3v13.4" />
      <path d="M13.3 10.7 10.7 8 13.3 5.3" />
      <path d="M2.7 5.3 5.3 8 2.7 10.7" />
      <path d="M10.7 2.7 8 6.7 5.3 2.7" />
      <path d="M5.3 13.3 8 9.3 10.7 13.3" />
    </>
  ),
  more: (
    <>
      <circle cx="3.4" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.6" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Ico({ name, size = 16 }: { name: string; size?: number }) {
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
      {ICONS[name] ?? ICONS.check}
    </svg>
  );
}

/**
 * The confirmation beat every one-tap write ends in: inline, in the surface
 * the tap happened on, never a toast that can be missed.
 */
export function SuccessNote({
  title,
  detail,
}: {
  title: string;
  detail?: string | null;
}) {
  return (
    <div className="rounded-md border border-[#E2DFD5] bg-[#FAF9F5] px-3 py-2.5 text-[13px] leading-relaxed text-[#3D4A44]">
      <div className="flex items-center gap-1.5 font-medium text-[#2C6A46]">
        <Ico name="check" size={13} />
        {title}
      </div>
      {detail && <div className="mt-1 text-[#5B6560]">{detail}</div>}
    </div>
  );
}

/** Display-only Fraunces, the one place a heading departs from the system
 *  stack (source: portfolio's layout.tsx sidebar title and PageHead h1). The
 *  variable is set once on `<html>` in the root layout via next/font, so
 *  there is no extra network request here and no layout shift. */
export const displayFace = "font-[family-name:var(--font-fraunces)]";

export function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="mb-6">
      <h1 className={`${displayFace} text-[27px] leading-tight font-semibold tracking-tight`}>{title}</h1>
      {sub && <p className="mt-1.5 text-[14px] leading-relaxed text-[#5B6560]">{sub}</p>}
    </header>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-[#E2DFD5] bg-white p-5 ${className}`}>{children}</div>;
}

/** One skeleton bar for a loading.tsx (source: portfolio's lib/ui.tsx). */
export function SkeletonBar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-[#EDEBE3] motion-reduce:animate-none ${className}`} />;
}
