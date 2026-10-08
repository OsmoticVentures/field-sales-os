"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { holdScroll } from "../../../../lib/core/scroll-keeper";
import { project, runSpring } from "../../../../lib/core/spring";
import { Ico } from "../../../../lib/core/ui";

const EDGE = 28; // px of the left edge that starts the swipe
const COMMIT_DISTANCE = 0.35; // share of the width that commits on its own

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * The client view as a slide-over. It follows the finger from the left edge,
 * springs back if released early, and closes with router.back() so the screen
 * Juan came from returns exactly as he left it. Reduced motion swaps the
 * slide for a fade. With `onClose` (opened over the side panel) it hands back
 * to that instead of leaving the route.
 */
export function AccountSheet({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  const router = useRouter();
  const sheet = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const x = useRef(0);
  const stop = useRef<(() => void) | null>(null);
  const closing = useRef(false);
  const drag = useRef<{ id: number; startX: number; samples: { t: number; x: number }[] } | null>(null);

  const paint = useCallback((px: number) => {
    x.current = px;
    const w = window.innerWidth;
    const p = Math.min(1, Math.max(0, px / w));
    if (sheet.current) {
      sheet.current.style.transform = px ? `translate3d(${px}px,0,0)` : "";
      sheet.current.style.boxShadow = px > 0 ? `-12px 0 32px rgba(20,32,27,${0.16 * (1 - p)})` : "";
    }
    if (scrim.current) scrim.current.style.opacity = String(1 - p);
  }, []);

  // Critically damped spring from the live position with the finger's velocity.
  const spring = useCallback(
    (target: number, velocity: number, done?: () => void) => {
      stop.current?.();
      stop.current = runSpring({
        from: x.current,
        to: target,
        velocity,
        onFrame: paint,
        onDone: () => {
          paint(target);
          done?.();
        },
      });
    },
    [paint],
  );

  const close = useCallback(
    (velocity = 0) => {
      if (closing.current) return;
      closing.current = true;
      const finish = () => (onClose ? onClose() : router.back());
      if (reduced()) {
        sheet.current?.animate({ opacity: [1, 0] }, { duration: 150, fill: "forwards" }).finished.then(finish, finish);
        return;
      }
      spring(window.innerWidth, velocity, finish);
    },
    [router, spring, onClose],
  );

  // Enter from the right (fade under reduced motion), before first paint.
  useLayoutEffect(() => {
    if (reduced()) {
      sheet.current?.animate({ opacity: [0, 1] }, { duration: 150 });
      return;
    }
    paint(window.innerWidth);
    spring(0, 0);
    return () => stop.current?.();
  }, [paint, spring]);

  useEffect(() => holdScroll(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const onDown = (e: React.PointerEvent) => {
    if (closing.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    stop.current?.();
    drag.current = { id: e.pointerId, startX: e.clientX - x.current, samples: [{ t: e.timeStamp, x: e.clientX }] };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.samples.push({ t: e.timeStamp, x: e.clientX });
    if (d.samples.length > 6) d.samples.shift();
    if (!reduced()) paint(Math.max(0, e.clientX - d.startX));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const v = last.t > first.t ? ((last.x - first.x) / (last.t - first.t)) * 1000 : 0;
    const travelled = Math.max(0, e.clientX - d.startX);
    const w = window.innerWidth;
    const lands = travelled + project(v);
    if (e.type === "pointercancel" || (lands < w * COMMIT_DISTANCE && v < 600)) {
      if (reduced()) return;
      spring(0, v);
    } else {
      close(v);
    }
  };

  return (
    <>
      <div ref={scrim} aria-hidden className="pointer-events-none fixed inset-0 z-50 bg-[#14201B]/25" />
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Client"
        className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-[#F7F6F1] text-[#14201B] will-change-transform"
      >
        <div className="mx-auto max-w-[1100px] px-5 pb-10 [padding-bottom:calc(2.5rem+env(safe-area-inset-bottom))] [padding-top:calc(0.75rem+env(safe-area-inset-top))] md:px-9">
          <button
            type="button"
            onClick={() => close()}
            aria-label="Back"
            className="-ml-2 mb-3 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[#3D4A44] transition-transform hover:text-[#14201B] active:scale-[0.95] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <Ico name="chevron-left" size={20} />
          </button>
          {children}
        </div>
        <div
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          style={{ width: EDGE, touchAction: "none" }}
          className="fixed inset-y-0 left-0 z-10 md:hidden"
        />
      </div>
    </>
  );
}
