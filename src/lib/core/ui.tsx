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
 */

import type { ReactNode } from "react";

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

export function PageHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-[27px] leading-tight font-semibold tracking-tight">{title}</h1>
      {sub && <p className="mt-1.5 text-[14px] leading-relaxed text-[#5B6560]">{sub}</p>}
    </header>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-[#E2DFD5] bg-white p-5 ${className}`}>{children}</div>;
}
