"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

/**
 * Remembers the window's scroll position so a slide-over can hand it back.
 * Next resets scroll to the top when the client view opens; the screen under
 * it must come back where it was. Frozen while a slide-over is up.
 */
let lastY = 0;
let lastPath = "";
let holds = 0;

/** The screen under a slide-over is the last path that was not a client view. */
const rememberPath = () => {
  if (holds === 0 && !location.pathname.includes("/account/")) lastPath = location.pathname;
};

export function ScrollKeeper() {
  const pathname = usePathname();
  useEffect(rememberPath, [pathname]);
  useEffect(() => {
    const onScroll = () => {
      if (holds === 0) lastY = window.scrollY;
    };
    lastY = window.scrollY;
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return null;
}

/** The position the screen under a slide-over left at. Read it right as the
 *  slide-over mounts, before anything resets the window. */
export function savedScrollY(): number {
  return lastY;
}

/** Puts the window back at `y`, but only while the screen that was under the
 *  slide-over is still the one showing. A link taken from inside it opens
 *  another screen, which must start at its own top. */
export function restoreScroll(y: number): void {
  if (location.pathname === lastPath) window.scrollTo(0, y);
}

/** Call when a slide-over mounts; the returned function releases it. Holds
 *  stack: a view opened over the drawer keeps the position frozen until the
 *  last one lets go. */
export function holdScroll(): () => void {
  holds++;
  const y = lastY;
  const restore = () => window.scrollTo(0, y);
  const timers = [0, 60, 200].map((ms) => window.setTimeout(restore, ms));
  const raf = requestAnimationFrame(restore);
  const path = lastPath;
  const restoreIfSame = () => {
    if (location.pathname === path) restore();
  };
  return () => {
    timers.forEach(clearTimeout);
    cancelAnimationFrame(raf);
    restoreIfSame();
    requestAnimationFrame(() => {
      restoreIfSame();
      holds = Math.max(0, holds - 1);
    });
  };
}
