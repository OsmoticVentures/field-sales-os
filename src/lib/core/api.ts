// The app is served under next.config.ts basePath "/nb". Next rewrites page
// routes and <Link> for that automatically, but a plain fetch("/api/...") does
// not get the prefix and 404s. Every client-side fetch goes through here.
export const BASE_PATH = "/nb";

export function apiPath(path: string): string {
  return `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // Any write can change what a cached read would show, so every non-GET
  // clears the read cache below. Blunt on purpose: a screen never repaints
  // data from before a write the rep just made.
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && !POST_READS.has(path.split("?")[0])) reads.clear();
  return fetch(apiPath(path), init);
}

/** POSTs that only compute and write nothing (each route's own header says
 *  "Read-only"), so they leave the read cache alone. */
const POST_READS = new Set([
  "/api/route/drive",
  "/api/route/lookup",
  "/api/fuel/find",
  "/api/search/suggest-categories",
  "/api/expenses/classify",
]);

/**
 * THE READ CACHE. A screen that loads its data on mount (Route, Expenses,
 * Plan, Search, Visit review) reads through getJson, so:
 *  - a second screen asking for the same path while the first request is in
 *    flight shares it (no duplicate round trip);
 *  - returning to a screen repaints its last data at once (peekJson) while a
 *    fresh copy loads underneath;
 *  - a tab press can start a screen's reads before the screen mounts
 *    (warmJson, see Nav.tsx).
 * Memory only, per tab, cleared by any write through apiFetch. Only ok:true
 * JSON is kept, so an error is never replayed.
 */
type Entry = { at: number; data?: unknown; inflight?: Promise<unknown> };
const reads = new Map<string, Entry>();
const WARM_MS = 4000; // a warm started this recently is reused, not refetched
const KEEP_MS = 10 * 60 * 1000; // older than this is not worth repainting

function load(path: string): Promise<unknown> {
  const entry = reads.get(path) ?? { at: 0 };
  const p = fetch(apiPath(path), { cache: "no-store" })
    .then((r) => r.json())
    .then((json: unknown) => {
      const current = reads.get(path);
      // A write cleared the cache mid-flight: hand the caller this answer
      // but do not store it, it may predate the write.
      if (current?.inflight === p) {
        if ((json as { ok?: boolean } | null)?.ok !== false) reads.set(path, { at: Date.now(), data: json });
        else reads.delete(path);
      }
      return json;
    })
    .catch((e: unknown) => {
      if (reads.get(path)?.inflight === p) reads.set(path, { at: entry.at, data: entry.data });
      throw e;
    });
  reads.set(path, { at: entry.at, data: entry.data, inflight: p });
  return p;
}

/** A fresh read of `path`, sharing any request already in flight or started
 *  by a warm in the last few seconds. */
export function getJson<T>(path: string): Promise<T> {
  const e = reads.get(path);
  if (e?.inflight) return e.inflight as Promise<T>;
  if (e?.data !== undefined && Date.now() - e.at < WARM_MS) return Promise.resolve(e.data as T);
  return load(path) as Promise<T>;
}

/** The last good answer for `path`, for painting before the fresh one lands. */
export function peekJson<T>(path: string): T | undefined {
  const e = reads.get(path);
  if (!e || e.data === undefined || Date.now() - e.at > KEEP_MS) return undefined;
  return e.data as T;
}

/** Start reading `path` now, ignore the result. */
export function warmJson(path: string): void {
  if (typeof window === "undefined") return;
  void getJson(path).catch(() => {});
}
