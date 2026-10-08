"use client";

import { useEffect } from "react";
import { BASE_PATH } from "./api";

/**
 * Registers the service worker (public/sw.js, built from
 * scripts/sw.template.js; OFFLINE.md says why) on whichever screen the app
 * opens to, and checks for a newer one when the app comes back to the front,
 * at most every half hour. Production only: in dev it would serve stale
 * chunks to a hot reload. Renders nothing.
 */
const CHECK_GAP_MS = 30 * 60 * 1000;

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    let lastCheck = Date.now();
    let reg: ServiceWorkerRegistration | null = null;

    navigator.serviceWorker
      .register(`${BASE_PATH}/sw.js`, { scope: BASE_PATH, updateViaCache: "none" })
      .then((r) => {
        reg = r;
      })
      .catch(() => {
        /* no worker: the app runs as before, from the network */
      });

    // The screen painted from the phone's copy, but this browser is signed
    // out: go to the gate now, not on the first failed write.
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type !== "signed-out") return;
      if (window.location.pathname.startsWith(`${BASE_PATH}/gate`)) return;
      const next = window.location.pathname.slice(BASE_PATH.length) || "/";
      window.location.replace(`${BASE_PATH}/gate?next=${encodeURIComponent(next)}`);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    const onVisible = () => {
      if (document.visibilityState !== "visible" || !reg) return;
      if (Date.now() - lastCheck < CHECK_GAP_MS) return;
      lastCheck = Date.now();
      void reg.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMessage);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}

/** Tell the worker whose data it may keep; another rep's id wipes its copies. */
export function tellWorkerRep(id: string | null): void {
  try {
    const sw = navigator.serviceWorker?.controller;
    if (!sw) return;
    sw.postMessage(id ? { type: "rep", id } : { type: "clear-rep" });
  } catch {
    /* no worker */
  }
}
