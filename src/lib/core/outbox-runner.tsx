"use client";

import { useEffect } from "react";
import { laTodayIso } from "../features/route/field-week";
import { patchJson } from "./api";
import { onAccountFiled, startOutbox } from "./outbox";
import { startWriteQueue } from "./writeq";

type RouteCopy = { draft?: Record<string, unknown[]>; done?: Record<string, string[]>; logged?: Record<string, string[]> };

/** A visit filed for one of today's stops marks it done, as the route read
 *  does on the server; the phone's copy of the route says so too, so the
 *  next open never paints that stop as still to visit. */
function markStopDone(id: string) {
  const today = laTodayIso();
  patchJson<RouteCopy>("/api/route/state", (r) => {
    if (!r?.draft?.[today]?.includes(id) || r.done?.[today]?.includes(id)) return undefined;
    return {
      ...r,
      done: { ...r.done, [today]: [...(r.done?.[today] ?? []), id] },
      logged: { ...r.logged, [today]: [...(r.logged?.[today] ?? []), id] },
    };
  });
}

/** Starts the visit outbox's worker and the write queue's (writeq.ts) once,
 *  on whichever screen the app opens to, so a saved write sends from anywhere. When a note completes, the
 *  phone's copy of that client is refetched so its view shows the note.
 *  Renders nothing. */
export function OutboxRunner() {
  useEffect(() => {
    const stop = startOutbox();
    const stopWrites = startWriteQueue();
    const off = onAccountFiled((id) => {
      // Loaded lazily and allowed to fail: a missed refresh is caught by the
      // next sync, and must never stop the outbox.
      import("./phone-sync").then((m) => m.refreshAccount?.(id)).catch(() => {});
      markStopDone(id);
    });
    return () => {
      off();
      stop();
      stopWrites();
    };
  }, []);
  return null;
}
