"use client";

import { useEffect } from "react";
import { BASE_PATH } from "./api";

/**
 * Registers the service worker (/nb/sw.js, src/app/sw.js/route.ts, from
 * scripts/sw.template.js; OFFLINE.md says why) on whichever screen the app
 * opens to, and checks for a newer one when the app comes back to the front,
 * at most once a minute. A newer build that takes over reloads the screen
 * while it is out of sight, or before he has touched it since it opened or
 * came back, never under a half-typed note, so
 * an app left open on the phone runs today's build, not the one it launched
 * with. On the Mac (the iPhone build in a window) the screen never goes
 * hidden when he switches apps, so window focus and blur count too: he was
 * left on a morning build all day (2026-10-29). Production only: in dev it would serve stale chunks to a hot reload.
 * Renders nothing.
 */
const CHECK_GAP_MS = 60 * 1000;

/** Text in a box he has not sent: a reload would lose it. */
function typing(): boolean {
  return Array.from(document.querySelectorAll("textarea")).some((t) => t.value.trim() !== "");
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    let lastCheck = Date.now();
    // Untouched since it opened or came back: a reload costs nothing.
    let untouched = true;
    const onTouch = () => {
      untouched = false;
    };
    let reg: ServiceWorkerRegistration | null = null;
    // The first worker ever taking control is not a new build.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let newBuild = false;

    const reloadIfSafe = () => {
      if (!newBuild || typing()) return;
      if (document.visibilityState === "hidden" || untouched) window.location.reload();
    };
    const onController = () => {
      if (!hadController) return;
      newBuild = true;
      reloadIfSafe();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onController);
    window.addEventListener("pointerdown", onTouch, true);
    window.addEventListener("keydown", onTouch, true);

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
      if (document.visibilityState !== "visible") return reloadIfSafe();
      untouched = true;
      reloadIfSafe();
      if (!reg) return;
      if (Date.now() - lastCheck < CHECK_GAP_MS) return;
      lastCheck = Date.now();
      void reg.update().catch(() => {});
    };
    document.addEventListener("visibilitychange", onVisible);
    const onFocus = () => {
      untouched = true;
      reloadIfSafe();
      if (!reg || Date.now() - lastCheck < CHECK_GAP_MS) return;
      lastCheck = Date.now();
      void reg.update().catch(() => {});
    };
    const onBlur = () => {
      if (newBuild && !typing()) window.location.reload();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      navigator.serviceWorker.removeEventListener("controllerchange", onController);
      window.removeEventListener("pointerdown", onTouch, true);
      window.removeEventListener("keydown", onTouch, true);
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
