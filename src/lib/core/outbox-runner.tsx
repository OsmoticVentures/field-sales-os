"use client";

import { useEffect } from "react";
import { onAccountFiled, startOutbox } from "./outbox";

/** Starts the visit outbox's worker once, on whichever screen the app opens
 *  to, so a saved note files from anywhere. When a note completes, the
 *  phone's copy of that client is refetched so its view shows the note.
 *  Renders nothing. */
export function OutboxRunner() {
  useEffect(() => {
    const stop = startOutbox();
    const off = onAccountFiled((id) => {
      // Loaded lazily and allowed to fail: a missed refresh is caught by the
      // next sync, and must never stop the outbox.
      import("./phone-sync").then((m) => m.refreshAccount?.(id)).catch(() => {});
    });
    return () => {
      off();
      stop();
    };
  }, []);
  return null;
}
