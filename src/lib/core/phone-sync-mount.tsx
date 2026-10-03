"use client";

import { useEffect } from "react";
import { syncSnapshot } from "./phone-sync";

/**
 * Keeps the phone's copy of the book current: checks on app open and each
 * time the app comes back to the front, and downloads only when the last
 * download is over 11 hours old (phone-sync.ts). Mounted once in the layout.
 */
export function PhoneSync() {
  useEffect(() => {
    void syncSnapshot();
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncSnapshot();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  return null;
}
