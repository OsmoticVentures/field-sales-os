"use client";

import { useEffect } from "react";

/**
 * Remembers the window's scroll position so a slide-over can hand it back.
 * Next resets scroll to the top when the client view opens; the screen under
 * it must come back where it was. Frozen while a slide-over is up.
 */
let lastY = 0;
let frozen = false;

export function ScrollKeeper() {
  useEffect(() => {
    const onScroll = () => {
      if (!frozen) lastY = window.scrollY;
    };
    lastY = window.scrollY;
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return null;
}

/** Call when a slide-over mounts; the returned function releases it. */
export function holdScroll(): () => void {
  frozen = true;
  const y = lastY;
  const restore = () => window.scrollTo(0, y);
  const timers = [0, 60, 200].map((ms) => window.setTimeout(restore, ms));
  const raf = requestAnimationFrame(restore);
  return () => {
    timers.forEach(clearTimeout);
    cancelAnimationFrame(raf);
    restore();
    requestAnimationFrame(() => {
      restore();
      frozen = false;
    });
  };
}
