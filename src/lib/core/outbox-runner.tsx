"use client";

import { useEffect } from "react";
import { onAccountFiled, startOutbox } from "./outbox";
import { startWriteQueue } from "./writeq";

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
    });
    return () => {
      off();
      stop();
      stopWrites();
    };
  }, []);
  return null;
}
