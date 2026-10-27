"use client";

/**
 * The client's side panel, opened in place with no round trip. A link to
 * /account/<id> normally navigates, so the tap waits for the server's answer
 * for the intercepted route (@modal) before anything moves. Here the tap
 * pushes the same URL itself and draws AccountDrawer at once, from what the
 * screen already knows about the client, then the phone's copy of the book.
 * Back, a close and every tile behave as with the routed panel: the drawer's
 * close is router.back(), which pops this entry, and a reload of the URL
 * opens the full client view as before.
 *
 * The panel draws on the tap's own frame, not when the router catches up
 * with the pushed URL (that update re-renders the screen under it), and
 * leaves when the history entry does.
 *
 * The drawer's code is loaded once the screen is idle, so the first tap does
 * not wait on it and the screen's own first paint does not carry it. Not
 * React.lazy: a lazy component suspends on its first render even when its
 * code is already here, and React holds a revealed boundary back ~300 ms.
 */
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { apiPath } from "../../../../lib/core/api";
import type { AccountDrawer as Drawer, AccountSeed } from "./AccountDrawer";

let AccountDrawer: typeof Drawer | null = null;
const loadDrawer = () =>
  import("./AccountDrawer").then((m) => {
    AccountDrawer = m.AccountDrawer;
  });

export function useAccountPanel(): { open: (e: React.MouseEvent, seed: AccountSeed) => void; panel: React.ReactNode } {
  const [seed, setSeed] = useState<AccountSeed | null>(null);
  const shown = seed?.id ?? null;

  // Back, a swipe back, or the drawer's own close pops the entry.
  useEffect(() => {
    if (!shown) return;
    const onPop = () => {
      if (location.pathname !== apiPath(`/account/${shown}`)) setSeed(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [shown]);

  useEffect(() => {
    const warm = () => void loadDrawer().catch(() => {});
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (h: number) => void };
    if (w.requestIdleCallback) {
      const h = w.requestIdleCallback(warm);
      return () => w.cancelIdleCallback?.(h);
    }
    const t = setTimeout(warm, 1500);
    return () => clearTimeout(t);
  }, []);

  const open = useCallback((e: React.MouseEvent, next: AccountSeed) => {
    // A modified click (new tab, new window) keeps the link's own behavior.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    window.history.pushState(null, "", apiPath(`/account/${next.id}`));
    if (AccountDrawer) setSeed(next);
    else void loadDrawer().then(() => location.pathname === apiPath(`/account/${next.id}`) && setSeed(next));
  }, []);

  const panel =
    shown && AccountDrawer ? createPortal(<AccountDrawer key={shown} id={shown} seed={seed ?? undefined} />, document.body) : null;
  return { open, panel };
}
