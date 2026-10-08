"use client";

/**
 * WHOSE DATA THIS PHONE HOLDS. Two reps share the app, one PIN each, and a
 * phone one rep signed out of may be signed in to by the other. Every copy
 * the app keeps of a rep's data (the reads and the book in IndexedDB, the
 * screens the service worker kept) is wiped the moment a different rep is
 * seen, before any screen can paint from it. Writes still waiting to send are
 * kept: each names its rep and only that rep's session sends it.
 *
 * Called at sign-in (GateForm) and on each /api/me answer (me.ts).
 */
import { currentRep, REP_KEY, replaceAll } from "./phone-store";
import { tellWorkerRep } from "./sw-register";

/** Record `id` as the rep on this phone. Resolves true when it replaced a
 *  different rep, whose copies are now gone: the caller reloads the page so
 *  nothing held in memory survives either. */
export async function adoptRep(id: string): Promise<boolean> {
  const prior = currentRep();
  if (prior === id) {
    tellWorkerRep(id);
    return false;
  }
  if (prior) await wipeRepData();
  try {
    localStorage.setItem(REP_KEY, id);
  } catch {
    // Private mode: reads are keyed under "_" and wiped on every change seen.
  }
  tellWorkerRep(id);
  return prior !== null;
}

/** Every rep-held copy on this phone: IndexedDB reads and book, the
 *  remembered rep, and the service worker's rep screens. */
export async function wipeRepData(): Promise<void> {
  await replaceAll("reads", []).catch(() => false);
  await replaceAll("snap", []).catch(() => false);
  try {
    localStorage.removeItem("nb_me");
    localStorage.removeItem(REP_KEY);
  } catch {
    /* nothing remembered */
  }
  tellWorkerRep(null);
}
