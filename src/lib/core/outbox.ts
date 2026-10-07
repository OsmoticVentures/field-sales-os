/**
 * THE OUTBOX. Every visit note is saved on the phone the moment Log is
 * tapped, then filed in the background until HubSpot has confirmed it. The
 * stages and the rules for when an item may leave live in outbox-core.ts
 * (pure, tested in tests/outbox.test.mts); this file is the browser half:
 * the phone store, the network, the lock, and the triggers.
 *
 * The worker runs on any screen (OutboxRunner sits in the root layout): on
 * app start, right after a note is saved, when signal comes back, when the
 * app returns to the foreground, and on a timer while anything is waiting.
 * One tab runs it at a time (navigator.locks, or a flag where that is
 * missing). Every write it sends carries a key derived from the item id, so a
 * retry of a write that did land is replayed by the server, never redone.
 *
 * BOUND: the store holds only unconfirmed notes; each leaves on confirmation
 * or a tapped discard.
 */

import { useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import { all, del, durable, put } from "./phone-store";
import {
  advance,
  isComplete,
  isDue,
  newItem,
  pickAccount,
  pickType,
  wake,
  waitsForType,
  type Deps,
  type EnqueueInput,
  type OutboxItem,
  type Outcome,
  type Req,
} from "./outbox-core";

export type { OutboxItem } from "./outbox-core";

/** A note that just completed, kept on screen for its confirmation beat. */
export type OutboxDone = { id: string; label: string; hubspot: OutboxItem["hubspot"]; outbound: OutboxItem["outbound"] };

type State = { items: OutboxItem[]; done: OutboxDone[]; running: string | null };

const STORE = "outbox" as const;
const LOCK = "clientos-outbox";
const TIMEOUT_MS = 75_000; // past the routes' 60s maxDuration
const TICK_MS = 20_000;
const BEAT_MS = 1100;
/** Long enough to tap through to the draft the visit just queued. */
const DRAFTED_BEAT_MS = 8000;

let cache = new Map<string, OutboxItem>();
let state: State = { items: [], done: [], running: null };
const listeners = new Set<() => void>();
const discarded = new Set<string>();
let loaded: Promise<void> | null = null;
let current: Promise<void> | null = null;
let again = false;
let forceAgain = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let channel: BroadcastChannel | null = null;
const filedListeners = new Set<(accountId: string) => void>();

function emit() {
  state = {
    items: [...cache.values()].sort((a, b) => a.createdAt - b.createdAt),
    done: state.done,
    running: state.running,
  };
  for (const l of listeners) l();
}

function load(): Promise<void> {
  if (!loaded) {
    loaded = all<OutboxItem>(STORE).then((rows) => {
      for (const { key, value } of rows) if (value && !discarded.has(key)) cache.set(key, value);
      emit();
    });
  }
  return loaded;
}

async function reload() {
  const rows = await all<OutboxItem>(STORE);
  cache = new Map(rows.filter((r) => r.value && !discarded.has(r.key)).map((r) => [r.key, r.value]));
  emit();
}

async function save(it: OutboxItem) {
  if (discarded.has(it.id)) return;
  cache.set(it.id, it);
  emit();
  await put(STORE, it.id, it);
  channel?.postMessage("changed");
}

async function remove(id: string) {
  cache.delete(id);
  emit();
  await del(STORE, id);
  channel?.postMessage("changed");
}

// ---------------------------------------------------------------------------
// the network
// ---------------------------------------------------------------------------

async function send(req: Req): Promise<Outcome> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    let init: RequestInit;
    if (req.form) {
      const form = new FormData();
      form.set("touchpoint_id", req.form.touchpoint_id);
      form.set("idempotency_key", req.form.idempotency_key);
      const p = req.form.photo;
      form.set("photo", new Blob([p.bytes], { type: p.type || "image/jpeg" }), p.name || "photo.jpg");
      init = { method: "POST", body: form };
    } else {
      init = {
        method: "POST",
        headers: { "content-type": "application/json", ...(req.key ? { "idempotency-key": req.key } : {}) },
        body: JSON.stringify(req.json ?? {}),
      };
    }
    res = await apiFetch(req.path, { ...init, signal: ctl.signal });
  } catch {
    return { type: "network" };
  } finally {
    clearTimeout(t);
  }
  const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; error?: string } | null;
  if (res.ok && data?.ok) return { type: "ok", result: data.result };
  // An unreadable answer (a gateway page, a cut body) is retried like a 5xx.
  return { type: "http", status: !data && res.status < 400 ? 502 : res.status, error: data?.error ?? null };
}

const deps: Deps = {
  send,
  save,
  remove,
  now: () => Date.now(),
  rand: () => Math.random(),
  online: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
};

// ---------------------------------------------------------------------------
// the worker
// ---------------------------------------------------------------------------

function label(it: OutboxItem): string {
  if (it.accountName) return it.accountName;
  const words = it.text.trim().split(/\s+/);
  return words.length > 6 ? `${words.slice(0, 6).join(" ")}…` : words.join(" ");
}

function beat(it: OutboxItem) {
  const outbound = it.outbound ?? null;
  state = { ...state, done: [...state.done, { id: it.id, label: label(it), hubspot: it.hubspot, outbound }] };
  emit();
  // An email that was owed and could not be written stays until he clears it.
  if (outbound?.status === "not_written") return;
  setTimeout(() => dismissDone(it.id), outbound?.status === "drafted" ? DRAFTED_BEAT_MS : BEAT_MS);
}

export function dismissDone(id: string) {
  state = { ...state, done: state.done.filter((d) => d.id !== id) };
  emit();
}

async function pass(force: boolean) {
  await load();
  const now = Date.now();
  for (const id of [...cache.keys()]) {
    const it = cache.get(id);
    if (!it || discarded.has(id)) continue;
    // A complete item whose delete missed the disk last time leaves now.
    if (isComplete(it)) {
      await remove(id);
      continue;
    }
    const ready = force ? wake(it, now) : it;
    if (!isDue(ready, now)) continue;
    state = { ...state, running: id };
    emit();
    const { item, removed } = await advance(ready, deps);
    state = { ...state, running: null };
    if (removed) {
      beat(item);
      if (item.accountId) for (const fn of filedListeners) fn(item.accountId);
    } else emit();
  }
}

/** Run every due item once. Single-flight per tab and across tabs; a call
 *  that arrives mid-run makes the run go round once more. `force` is the
 *  "Try now" tap: everything not waiting on a store is due at once. */
export function runOutbox(force = false): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (current) {
    again = true;
    forceAgain ||= force;
    return current;
  }
  current = (async () => {
    try {
      do {
        again = false;
        force ||= forceAgain;
        forceAgain = false;
        const locks = (navigator as Navigator & { locks?: LockManager }).locks;
        if (locks?.request) {
          await locks.request(LOCK, { ifAvailable: true }, async (lock) => {
            if (lock) await pass(force);
          });
        } else {
          await pass(force);
        }
        force = false;
      } while (again);
    } catch {
      /* a pass that throws is retried by the next trigger; nothing is deleted */
    } finally {
      current = null;
      schedule();
    }
  })();
  return current;
}

/** One timer, at the earliest item due, never more than 20s away while
 *  anything waits, and none at all when the outbox is empty. */
function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  const waiting = [...cache.values()].filter((it) => !it.parked && !waitsForType(it));
  if (waiting.length === 0) return;
  const soonest = Math.min(...waiting.map((it) => Math.max(it.nextAt, it.holdUntil)));
  const wait = Math.min(Math.max(soonest - Date.now(), 1000), TICK_MS);
  timer = setTimeout(() => void runOutbox(), wait);
}

let started = false;
/** Called once by OutboxRunner. Loads what the phone kept and starts filing. */
export function startOutbox(): () => void {
  if (typeof window === "undefined" || started) return () => {};
  started = true;
  try {
    channel = new BroadcastChannel(LOCK);
    channel.onmessage = () => void reload();
  } catch {
    channel = null;
  }
  const onOnline = () => void runOutbox(true);
  const onVisible = () => document.visibilityState === "visible" && void runOutbox();
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  void runOutbox();
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

export type EnqueueResult = { id: string; durable: boolean };

/**
 * Save a note on the phone and start filing it. Resolves once the write is
 * on the disk; `durable` false means the phone store is unavailable and the
 * note lives only while the app is open, which the screen must say.
 */
export async function enqueue(input: Omit<EnqueueInput, "id" | "now"> & { photoFile?: File | null }): Promise<EnqueueResult> {
  const id = crypto.randomUUID();
  let photo: OutboxItem["photo"] = null;
  if (input.photoFile) {
    photo = { bytes: await input.photoFile.arrayBuffer(), type: input.photoFile.type, name: input.photoFile.name };
  }
  await load();
  const it = newItem({ ...input, photo, id, now: Date.now() });
  cache.set(id, it);
  emit();
  const wrote = await put(STORE, id, it);
  const onDisk = wrote && (await durable());
  channel?.postMessage("changed");
  void runOutbox();
  return { id, durable: onDisk };
}

/** One of the closest stores, tapped on a note that could not tell. */
export async function fileTo(id: string, account: { id: string; name: string }): Promise<void> {
  const it = cache.get(id);
  if (!it) return;
  await save(pickAccount(it, account, Date.now()));
  void runOutbox();
}

/** The type of a store New company created, or null to leave it as is. */
export async function chooseType(id: string, channel: string | null): Promise<void> {
  const it = cache.get(id);
  if (!it) return;
  const next = pickType(it, channel, Date.now());
  if (isComplete(next)) {
    await remove(id);
    beat(next);
    return;
  }
  await save(next);
  void runOutbox();
}

/** Discard, after the two-tap confirm: the only other way an item leaves. */
export async function discard(id: string): Promise<void> {
  discarded.add(id);
  await remove(id);
}

/** Back to the composer: an unfiled note leaves the outbox and its text,
 *  reads and photo return to the screen, so nothing is lost. */
export async function takeBack(id: string): Promise<OutboxItem | null> {
  const it = cache.get(id);
  if (!it || it.filed || state.running === id) return null;
  discarded.add(id);
  await remove(id);
  return it;
}

/** Called with the account id each time a note completes, for a screen or
 *  the phone copy that wants to refresh that client. */
export function onAccountFiled(fn: (accountId: string) => void): () => void {
  filedListeners.add(fn);
  return () => filedListeners.delete(fn);
}

function subscribe(l: () => void) {
  listeners.add(l);
  void load();
  return () => listeners.delete(l);
}
const EMPTY: State = { items: [], done: [], running: null };

/** The live outbox: unconfirmed items, the ones mid-beat, and which is running. */
export function useOutbox(): State {
  return useSyncExternalStore(subscribe, () => state, () => EMPTY);
}

export { label as outboxLabel };
