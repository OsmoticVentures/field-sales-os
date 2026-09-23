/**
 * Prospect-only icon set, additive to lib/core/ui.tsx's `Ico` rather than an
 * edit to it (this port's concurrency rules keep every agent inside its own
 * feature folder). Same rendering shell as the core `Ico`, editorial SVG
 * strokes, never an emoji, never a spark/sparkle/star.
 *
 * SHARED-CORE NOTE: phone/route/mail/globe/pin/search/wand/book/edit/plus
 * are exactly the kind of icon another feature (Route Planner, Reports)
 * will also want. Fold this map into lib/core/ui.tsx's ICONS the next time
 * two features need the same glyph, rather than forking a third copy.
 */
import type { ReactNode } from "react";

const PROSPECT_ICONS: Record<string, ReactNode> = {
  check: <path d="m3 8.4 3.2 3.2L13 4.8" />,
  alert: (
    <>
      <path d="M8 2.6 14.2 13H1.8L8 2.6Z" />
      <path d="M8 6.6v3M8 11.4h.01" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.3 1.4" />
    </>
  ),
  plus: <path d="M8 2.8v10.4M2.8 8h10.4" />,
  phone: <path d="M4 2.6h2.2l1 2.6-1.4 1.2a8 8 0 0 0 3.8 3.8l1.2-1.4 2.6 1V12a1.4 1.4 0 0 1-1.4 1.4C7.7 13.4 2.6 8.3 2.6 4A1.4 1.4 0 0 1 4 2.6Z" />,
  route: (
    <>
      <circle cx="3.6" cy="4" r="1.4" />
      <circle cx="12.4" cy="12" r="1.4" />
      <path d="M3.6 5.4v2.2A2.4 2.4 0 0 0 6 10h4a2.4 2.4 0 0 1 2.4 2.4" />
    </>
  ),
  search: (
    <>
      <circle cx="6.8" cy="6.8" r="4.2" />
      <path d="m13 13-3.4-3.4" />
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
  pin: (
    <>
      <path d="M8 14s4.6-4.3 4.6-7.6A4.6 4.6 0 1 0 3.4 6.4C3.4 9.7 8 14 8 14Z" />
      <circle cx="8" cy="6.4" r="1.6" />
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
  edit: (
    <>
      <path d="M9.6 3.2 12.8 6.4 5.6 13.6 2.4 14l.4-3.2Z" />
    </>
  ),
  hubspot: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 2.6v3.2M11.4 5.4 9 7M11.4 10.6 9 9M4.6 10.6 7 9M4.6 5.4 7 7" />
    </>
  ),
};

export function PIco({ name, size = 16 }: { name: string; size?: number }) {
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
      {PROSPECT_ICONS[name] ?? PROSPECT_ICONS.check}
    </svg>
  );
}
