/**
 * THE WRITE QUEUE'S RULES. Pure: no IndexedDB, no fetch, no window, no
 * imports, so `node --experimental-strip-types` loads it for
 * tests/writeq.test.mts. The browser half is writeq.ts.
 *
 * One item is one write a screen made (clock in/out, a receipt, a trip)
 * that could not reach the server yet. The visit note has its own, richer
 * outbox (outbox-core.ts); this one is for the single-request writes.
 *
 *  - The item carries the Idempotency-Key the screen chose, so a resend of
 *    a write that did land is replayed by the server, never filed twice.
 *  - No signal, a timeout, a 5xx, a 401 or a 429: kept and retried, 5s up
 *    to every 10 minutes. A request that may still be running on the server
 *    is not resent before SERVER_WINDOW_MS has passed.
 *  - A refusal that asking again cannot change (400, 404, 405, 409, 413,
 *    415, 422): kept, marked failed with the server's reason, and never sent
 *    again by itself. The screen it came from shows it in red until he
 *    retries, edits or discards it. Nothing is ever dropped on an error.
 */

export type WqFile = { field: string; bytes: ArrayBuffer; type: string; name: string };

export type WqItem = {
  id: string;
  /** The rep whose session must send it; another rep's session never does. */
  rep: string | null;
  /** The screen whose card shows it, e.g. "expenses/hours". */
  screen: string;
  /** What its line reads, e.g. "Hours, 2026-10-08". */
  label: string;
  path: string;
  key: string;
  json?: unknown;
  fields?: Record<string, string>;
  files?: WqFile[];
  createdAt: number;
  attempts: number;
  nextAt: number;
  holdUntil: number;
  offline: boolean;
  lastError: string | null;
  /** A permanent refusal. Set: never sent again until he taps Try again. */
  failed: string | null;
};

export type WqInput = Pick<WqItem, "id" | "rep" | "screen" | "label" | "path" | "key" | "json" | "fields" | "files"> & { now: number };

export function newWrite(i: WqInput): WqItem {
  return {
    id: i.id,
    rep: i.rep,
    screen: i.screen,
    label: i.label,
    path: i.path,
    key: i.key,
    json: i.json,
    fields: i.fields,
    files: i.files,
    createdAt: i.now,
    attempts: 0,
    nextAt: i.now,
    holdUntil: 0,
    offline: false,
    lastError: null,
    failed: null,
  };
}

export type WqOutcome =
  | { type: "ok"; result: unknown }
  | { type: "network" }
  | { type: "http"; status: number; error: string | null };

/** 5s, 15s, 30s, 1m, 2m, 5m, then every 10m, each within 10% either way. */
const LADDER = [5, 15, 30, 60, 120, 300];
export function backoffMs(attempts: number, rand: number): number {
  const s = attempts <= 0 ? LADDER[0] : (LADDER[attempts - 1] ?? 600);
  return Math.round(s * 1000 * (0.9 + 0.2 * rand));
}

/** Past the routes' 60s maxDuration: a first try has finished by then. */
export const SERVER_WINDOW_MS = 65_000;

export const PERMANENT = new Set([400, 404, 405, 409, 413, 415, 422]);

export type Ctx = { now: number; rand: number; sentOnline: boolean; sentAt: number };

export type Applied = { done: true; result: unknown } | { done: false; item: WqItem };

/** Fold one send's outcome into the item. */
export function applyWrite(it: WqItem, out: WqOutcome, ctx: Ctx): Applied {
  if (out.type === "ok") return { done: true, result: out.result };
  if (out.type === "http" && PERMANENT.has(out.status)) {
    return { done: false, item: { ...it, failed: out.error || "Not accepted.", lastError: out.error || "Not accepted.", offline: false } };
  }
  const offline = out.type === "network";
  const attempts = it.attempts + 1;
  let nextAt = ctx.now + backoffMs(attempts, ctx.rand);
  let holdUntil = it.holdUntil;
  if (offline && ctx.sentOnline) {
    holdUntil = Math.max(holdUntil, ctx.sentAt + SERVER_WINDOW_MS);
    nextAt = Math.max(nextAt, holdUntil);
  }
  return {
    done: false,
    item: { ...it, attempts, nextAt, holdUntil, offline, lastError: offline ? null : out.error || `Server error ${out.status}.` },
  };
}

/** Whether `it` belongs to the signed-in rep. An item saved before reps were
 *  recorded belongs to whoever is signed in. */
export const isMine = (it: { rep?: string | null }, rep: string | null): boolean => !it.rep || it.rep === rep;

export const isDueWrite = (it: WqItem, now: number): boolean => !it.failed && it.nextAt <= now && it.holdUntil <= now;

/** "Try now" and the reconnect: due at once, a failed one sent again, but
 *  never before a held write has surely finished on the server. */
export const wakeWrite = (it: WqItem, now: number, retryFailed: boolean): WqItem =>
  it.failed && !retryFailed ? it : { ...it, failed: retryFailed ? null : it.failed, nextAt: Math.max(now, it.holdUntil) };
