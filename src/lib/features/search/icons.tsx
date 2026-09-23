/**
 * Icons this feature needs that are not yet in lib/core/ui.tsx's Ico. Same
 * glyphs as portfolio/src/app/nutribiotic/lib/ui.tsx's ICONS map, copied only
 * for the names Search Map uses. Per PORTING.md, lib/core/ui.tsx is the right
 * home for these long-term ("add an icon or a primitive here when your
 * feature needs one"), but six agents are porting features into this repo at
 * once and lib/core is off limits for this pass; fold these six entries into
 * lib/core/ui.tsx's ICONS map in the integration pass (see this port's
 * report) and delete this file.
 */
import type { ReactNode } from "react";

const SEARCH_ICONS: Record<string, ReactNode> = {
  search: (
    <>
      <circle cx="6.9" cy="6.9" r="4.3" />
      <path d="m13.2 13.2-3.3-3.3" strokeLinecap="round" />
    </>
  ),
  "chevron-up": <path d="m4 10 4-4 4 4" />,
  "chevron-down": <path d="m4 6 4 4 4-4" />,
  plus: <path d="M8 2.6v10.8M2.6 8h10.8" />,
  wand: (
    <path d="M3 13 11 5M9.6 3.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5zM13 8.4l.35.9.9.35-.9.35-.35.9-.35-.9-.9-.35.9-.35z" />
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c2.1 1.9 2.1 10.5 0 12.4M8 1.8c-2.1 1.9-2.1 10.5 0 12.4" />
    </>
  ),
  "phone-arrow": (
    <g>
      <path d="M5.6 2.6H3.4c-.7 0-1.3.6-1.2 1.3.3 5.2 4.7 9.6 9.9 9.9.7.1 1.3-.5 1.3-1.2v-2.2l-2.8-.9-1.2 1.4a9.4 9.4 0 0 1-4.1-4.1l1.4-1.2z" />
      <path d="M9.8 2.6h3.6v3.6" />
      <path d="M13.4 2.6 9.6 6.4" />
    </g>
  ),
};

export function SearchIco({ name, size = 16 }: { name: string; size?: number }) {
  const glyph = SEARCH_ICONS[name];
  if (!glyph) return null;
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
      {glyph}
    </svg>
  );
}

/** One skeleton bar, same look as lib/core/ui.tsx would carry once a
 *  SkeletonBar primitive lands there (source: portfolio's lib/ui.tsx). */
export function SkeletonBar({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-[#EDEBE3] ${className}`} />;
}
