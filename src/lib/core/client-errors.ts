/**
 * Error capture, phone side. window errors, unhandled promise rejections and
 * React error boundaries all call reportClientError, which posts to
 * /api/errors/report (the server fingerprints and stores it, see
 * lib/core/errors.ts).
 *
 * Bounded here first: one page load sends the same message at most once a
 * minute and at most 10 reports in all, so a render loop cannot flood the
 * route. keepalive lets a report finish while the page is unloading. Never
 * throws: a broken reporter must not become a second error.
 */

/* basePath (next.config.ts) spelled out rather than imported from api.ts:
   this module runs before hydration, and api.ts opens the phone store on
   import, which is the app's job, not the reporter's. */
const REPORT_URL = "/nb/api/errors/report";

const sentAt = new Map<string, number>();
let total = 0;
const MAX_PER_PAGE = 10;
const SAME_MS = 60_000;

export function reportClientError(err: unknown, source: string): void {
  try {
    if (typeof window === "undefined") return;
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-Error rejection");
    // A server render failure arrives here with a digest and a generic
    // message; onRequestError already recorded the real one.
    if ((e as Error & { digest?: string }).digest) return;
    const message = `${e.name}: ${e.message}`.slice(0, 500);
    const now = Date.now();
    if (total >= MAX_PER_PAGE || now - (sentAt.get(message) ?? 0) < SAME_MS) return;
    sentAt.set(message, now);
    total += 1;
    void fetch(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, stack: (e.stack ?? "").slice(0, 4000), route: window.location.pathname, source }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // never throw from the reporter
  }
}

let installed = false;

export function installClientErrorCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (ev) => {
    // A failed <img>/<script> load has no error object; skip it, it is not a bug in our code.
    if (!ev.error && !ev.message) return;
    reportClientError(ev.error ?? new Error(ev.message), "window");
  });
  window.addEventListener("unhandledrejection", (ev) => reportClientError(ev.reason, "promise"));
}
