"use client";

/**
 * The Undo window behind every one-tap confirm. The screen shows the result at
 * once (the SuccessNote, with Undo); the write is held back for UNDO_MS and
 * only then sent. Undo inside the window cancels it, so nothing was ever
 * written and there is nothing to reverse. Leaving the screen or backgrounding
 * the app sends every held write at once, so a held write is never lost.
 * A refused write is the caller's to show in red, in place.
 *
 * BOUND: one entry per key, removed when it sends or is undone.
 */
import { useCallback, useEffect, useRef } from "react";

export const UNDO_MS = 4000;

type Held = { timer: ReturnType<typeof setTimeout>; run: () => void };

export function useUndoWindow(ms = UNDO_MS) {
  const held = useRef(new Map<string, Held>());

  useEffect(() => {
    const map = held.current;
    const sendAll = () => {
      for (const [key, h] of [...map]) {
        clearTimeout(h.timer);
        map.delete(key);
        h.run();
      }
    };
    window.addEventListener("pagehide", sendAll);
    return () => {
      window.removeEventListener("pagehide", sendAll);
      sendAll();
    };
  }, []);

  /** Hold `run`; it fires after the window unless undone first. */
  const arm = useCallback(
    (key: string, run: () => void) => {
      const map = held.current;
      const prev = map.get(key);
      if (prev) clearTimeout(prev.timer);
      const timer = setTimeout(() => {
        map.delete(key);
        run();
      }, ms);
      map.set(key, { timer, run });
    },
    [ms],
  );

  /** True when the write was still held and is now cancelled. */
  const undo = useCallback((key: string): boolean => {
    const h = held.current.get(key);
    if (!h) return false;
    clearTimeout(h.timer);
    held.current.delete(key);
    return true;
  }, []);

  return { arm, undo };
}
