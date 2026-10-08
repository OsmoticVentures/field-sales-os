/**
 * THE WRITE QUEUE. A write a screen makes with no signal (clock in/out, a
 * receipt, a trip) is saved on the phone and sent when signal returns. The
 * rules live in writeq-core.ts (pure, tested in tests/writeq.test.mts); this
 * file is the browser half: the phone store, the network, the lock, the
 * triggers. Visit notes have their own outbox (outbox.ts).
 *
 * FAIL LOUD, IN PLACE. submitWrite() makes the first try while the screen
 * waits, exactly as a plain fetch did:
 *  - it lands: "done", the screen shows its usual confirmation;
 *  - the server refuses it: "failed", the item leaves the queue and the
 *    screen keeps everything as typed with the reason in red;
 *  - no signal, a timeout or a gateway error: "queued", the screen may clear
 *    and the write goes on trying in the background, shown on its card and
 *    in the unsent count until it lands.
 * A queued write the server later refuses stays in the queue, marked failed,
 * in red on the card it came from, until he taps Try again, Edit or Discard.
 * Nothing is dropped on an error and nothing waits out of sight.
 *
 * ONE REP'S WRITES. Each item names its rep; only that rep's session sends it.
 *
 * BOUND: the store holds only unsent writes; each leaves when it lands or on
 * a tapped discard.
 */

import { useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { all, currentRep, del, put } from "./phone-store";
import { applyWrite, isDueWrite, isMine, newWrite, wakeWrite, type WqFile, type WqItem, type WqOutcome } from "./writeq-core";

export type { WqItem } from "./writeq-core";

const STORE = "writeq" as const;
const LOCK = "clientos-writeq";
const TIMEOUT_MS = 75_000;
const TICK_MS = 20_000;
const BEAT_MS = 1200;
/** A first try that comes back with one of these never reached the route. */
const UNREACHED = new Set([502, 503, 504]);

export type WriteDone = { id: string; screen: string; label: string; result: unknown };
type State = { items: WqItem[]; running: string | null; done: WriteDone[] };

let cache = new Map<string, WqItem>();
let state: State = { items: [], running: null, done: [] };
const listeners = new Set<() => void>();
const removed = new Set<string>();
/** Held by a screen's own first try: the worker leaves them alone. */
const foreground = new Set<string>();
let loaded: Promise<void> | null = null;
let current: Promise<void> | null = null;
let again = false;
let wakeAll = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let channel: BroadcastChannel | null = null;

function emit() {
  state = { ...state, items: [...cache.values()].sort((a, b) => a.createdAt - b.createdAt) };
  for (const l of listeners) l();
}

async function readDisk(): Promise<Map<string, WqItem>> {
  const rep = currentRep();
  const rows = await all<WqItem>(STORE);
  return new Map(rows.filter((r) => r.value && !removed.has(r.key) && isMine(r.value, rep)).map((r) => [r.key, r.value]));
}

function load(): Promise<void> {
  loaded ??= readDisk().then((m) => {
    for (const [k, v] of m) if (!cache.has(k)) cache.set(k, v);
    emit();
  });
  return loaded;
}

async function save(it: WqItem) {
  if (removed.has(it.id)) return;
  cache.set(it.id, it);
  emit();
  await put(STORE, it.id, it);
  channel?.postMessage("changed");
}

async function drop(id: string) {
  removed.add(id);
  cache.delete(id);
  emit();
  await del(STORE, id);
  channel?.postMessage("changed");
}

// ---------------------------------------------------------------------------
// the network
// ---------------------------------------------------------------------------

/** Names the rep who made the write; proxy.ts refuses it (421, retried
 *  here) under any other rep's session. */
function asRep(it: WqItem): Record<string, string> {
  const rep = it.rep ?? currentRep();
  return rep ? { "x-nb-as": rep } : {};
}

async function send(it: WqItem): Promise<WqOutcome> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    let init: RequestInit;
    if (it.files?.length || it.fields) {
      const form = new FormData();
      for (const [k, v] of Object.entries(it.fields ?? {})) form.set(k, v);
      for (const f of it.files ?? []) form.append(f.field, new Blob([f.bytes], { type: f.type || "application/octet-stream" }), f.name || "photo.jpg");
      form.set("idempotency_key", it.key);
      init = { method: "POST", headers: { "Idempotency-Key": it.key, ...asRep(it) }, body: form };
    } else {
      init = {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": it.key, ...asRep(it) },
        body: JSON.stringify(it.json ?? {}),
      };
    }
    res = await apiFetch(it.path, { ...init, signal: ctl.signal });
  } catch {
    return { type: "network" };
  } finally {
    clearTimeout(t);
  }
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; error?: string } | null;
  if (res.ok && data?.ok) return { type: "ok", result: data.result ?? data };
  return { type: "http", status: !data && res.status < 400 ? 502 : res.status, error: data?.error ?? null };
}

const online = () => (typeof navigator === "undefined" ? true : navigator.onLine !== false);

async function attempt(it: WqItem): Promise<{ landed: true; result: unknown } | { landed: false; item: WqItem; out: WqOutcome }> {
  const sentAt = Date.now();
  const sentOnline = online();
  const out = await send(it);
  const r = applyWrite(it, out, { now: Date.now(), rand: Math.random(), sentOnline, sentAt });
  return r.done ? { landed: true, result: r.result } : { landed: false, item: r.item, out };
}

function beat(d: WriteDone) {
  state = { ...state, done: [...state.done, d] };
  emit();
  setTimeout(() => {
    state = { ...state, done: state.done.filter((x) => x.id !== d.id) };
    emit();
  }, BEAT_MS);
}

// ---------------------------------------------------------------------------
// the worker
// ---------------------------------------------------------------------------

async function pass(wake: boolean) {
  await load();
  const now = Date.now();
  for (const id of [...cache.keys()]) {
    let it = cache.get(id);
    if (!it || removed.has(id) || foreground.has(id)) continue;
    if (wake) it = wakeWrite(it, now, false);
    if (!isDueWrite(it, now)) continue;
    state = { ...state, running: id };
    emit();
    const r = await attempt(it);
    state = { ...state, running: null };
    if (r.landed) {
      await drop(id);
      beat({ id, screen: it.screen, label: it.label, result: r.result });
    } else await save(r.item);
  }
}

/** Send every due write once. Single-flight per tab and across tabs. */
export function runWrites(wake = false): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (current) {
    again = true;
    wakeAll ||= wake;
    return current;
  }
  current = (async () => {
    try {
      do {
        again = false;
        wake ||= wakeAll;
        wakeAll = false;
        const locks = (navigator as Navigator & { locks?: LockManager }).locks;
        if (locks?.request) {
          await locks.request(LOCK, { ifAvailable: true }, async (lock) => {
            if (lock) await pass(wake);
          });
        } else await pass(wake);
        wake = false;
      } while (again);
    } catch {
      /* the next trigger tries again; nothing is deleted */
    } finally {
      current = null;
      schedule();
    }
  })();
  return current;
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  const waiting = [...cache.values()].filter((it) => !it.failed && !foreground.has(it.id));
  if (waiting.length === 0) return;
  const soonest = Math.min(...waiting.map((it) => Math.max(it.nextAt, it.holdUntil)));
  timer = setTimeout(() => void runWrites(), Math.min(Math.max(soonest - Date.now(), 1000), TICK_MS));
}

let started = false;
/** Called once from the root layout (OutboxRunner). */
export function startWriteQueue(): () => void {
  if (typeof window === "undefined" || started) return () => {};
  started = true;
  try {
    channel = new BroadcastChannel(LOCK);
    channel.onmessage = () =>
      void readDisk().then((m) => {
        cache = new Map([...m].filter(([k]) => !removed.has(k)));
        emit();
      });
  } catch {
    channel = null;
  }
  const onOnline = () => void runWrites(true);
  const onVisible = () => document.visibilityState === "visible" && void runWrites();
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  void runWrites();
  return () => {
    started = false;
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    channel?.close();
    channel = null;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

// ---------------------------------------------------------------------------
// what the screens call
// ---------------------------------------------------------------------------

export type WriteInput = {
  screen: string;
  label: string;
  path: string;
  /** The Idempotency-Key, chosen by the screen once per logical write. */
  key: string;
  json?: unknown;
  fields?: Record<string, string>;
  files?: { field: string; file: File }[];
};

export type SubmitResult = { status: "done"; result: unknown } | { status: "queued"; id: string } | { status: "failed"; error: string };

/**
 * Save the write on the phone, then try it once while the screen waits.
 * See the module comment for what each answer means to the screen.
 */
export async function submitWrite(input: WriteInput): Promise<SubmitResult> {
  const files: WqFile[] = [];
  for (const f of input.files ?? []) {
    files.push({ field: f.field, bytes: await f.file.arrayBuffer(), type: f.file.type, name: f.file.name });
  }
  await load();
  const id = crypto.randomUUID();
  const now = Date.now();
  // Held while this try runs; a restart mid-try resends it, same key, once
  // the server's window has passed.
  const it: WqItem = {
    ...newWrite({ id, rep: currentRep(), screen: input.screen, label: input.label, path: input.path, key: input.key, json: input.json, fields: input.fields, files: files.length ? files : undefined, now }),
    holdUntil: now + TIMEOUT_MS,
    nextAt: now + TIMEOUT_MS,
  };
  foreground.add(id);
  try {
    await save(it);
    const r = await attempt({ ...it, holdUntil: 0, nextAt: now });
    if (r.landed) {
      await drop(id);
      return { status: "done", result: r.result };
    }
    const reachedRoute = r.out.type === "http" && !UNREACHED.has(r.out.status);
    if (reachedRoute) {
      // The screen still holds every field: the reason goes there, in red.
      await drop(id);
      return { status: "failed", error: (r.out.type === "http" && r.out.error) || "Not accepted." };
    }
    await save(r.item);
    return { status: "queued", id };
  } finally {
    foreground.delete(id);
    schedule();
  }
}

/** Try a write again now, a failed one included. */
export async function retryWrite(id: string): Promise<void> {
  const it = cache.get(id);
  if (!it) return;
  await save(wakeWrite(it, Date.now(), true));
  void runWrites();
}

/** Discard, after the two-tap confirm. */
export async function discardWrite(id: string): Promise<void> {
  await drop(id);
}

/** Back to the screen to fix: the write leaves the queue and its fields
 *  return to the caller, so nothing is lost. Not while it is sending. */
export async function takeBackWrite(id: string): Promise<WqItem | null> {
  const it = cache.get(id);
  if (!it || state.running === id) return null;
  await drop(id);
  return it;
}

function subscribe(l: () => void) {
  listeners.add(l);
  void load();
  return () => listeners.delete(l);
}
const EMPTY: State = { items: [], running: null, done: [] };

/** The signed-in rep's unsent writes, which one is sending, and the ones
 *  that just landed. */
export function useWrites(): State {
  return useSyncExternalStore(subscribe, () => state, () => EMPTY);
}
