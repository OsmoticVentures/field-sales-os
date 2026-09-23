/**
 * Three icons the shared design system (src/lib/core/ui.tsx) does not carry
 * yet (pin, chevron up/down). PORTING.md's own instruction is to add a
 * missing icon to lib/core/ui.tsx directly, but this port's concurrency
 * rules bar editing lib/core while five other ports run in the same repo,
 * so they live here, feature-local, same visual language (16x16, stroke
 * currentColor) as core's Ico. Everything else routes through the real
 * Ico. Reported as a shared-change candidate in this port's handback.
 */
import type { ReactNode } from "react";
import { Ico } from "../../core/ui";

const EXTRA: Record<string, ReactNode> = {
  pin: <path d="M8 1.6c-2.4 0-4.3 1.9-4.3 4.3 0 3.2 4.3 8.5 4.3 8.5s4.3-5.3 4.3-8.5c0-2.4-1.9-4.3-4.3-4.3Zm0 6a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4Z" />,
  "chevron-up": <path d="M4 10 8 6l4 4" strokeLinecap="round" strokeLinejoin="round" />,
  "chevron-down": <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />,
};

export function RouteIco({ name, size = 16 }: { name: string; size?: number }) {
  if (name in EXTRA) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true" className="shrink-0">
        {EXTRA[name]}
      </svg>
    );
  }
  return <Ico name={name} size={size} />;
}
