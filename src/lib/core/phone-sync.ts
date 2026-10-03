/**
 * THE PHONE'S COPY OF THE BOOK. Every client's view data lives on the phone
 * (store "snap" in phone-store.ts), so opening a client paints at once with
 * no server wait. It refreshes from the server twice a day, not on every tap:
 *
 *  - syncSnapshot() downloads the whole book in one response
 *    (/api/account/snapshot) when the last download is over 11 hours old, and
 *    replaces the store in one transaction. A failure keeps the old copy and
 *    waits for the next app open, never a retry loop;
 *  - refreshAccount(id) refetches one client right after the app changes it
 *    (a tier, a note that landed), so the store and the screen agree;
 *  - getAccountPayload(id) reads the store, and on a miss fetches that one
 *    client and keeps it.
 *
 * Records are `acct:<id>` -> AccountPayload, plus `meta` -> SnapMeta.
 * Browser only. BOUND: the store is rewritten whole at each sync, so it never
 * outgrows the book plus the few clients fetched one at a time since.
 */
import type { AccountPayload } from "../features/clients/account-payload";
import { laTodayIso } from "../features/route/field-week";
import type { RouteDraftEntry } from "../features/route/types";
import { apiFetch } from "./api";
import { all, get, put, replaceAll } from "./phone-store";

export type SnapMeta = { syncedAt: string; builtAt: string; count: number };

const STALE_MS = 11 * 60 * 60 * 1000;
/** After a failed download, the next try waits at least this long. */
const RETRY_GAP_MS = 5 * 60 * 1000;

const key = (id: string) => `acct:${id}`;

/** Payloads already read this session, for a first paint with no wait. */
const mem = new Map<string, AccountPayload>();
const listeners = new Map<string, Set<(p: AccountPayload) => void>>();

function remember(id: string, p: AccountPayload): void {
  mem.set(id, p);
  listeners.get(id)?.forEach((fn) => fn(p));
}

/** This client's payload if it is already in memory, else undefined. */
export function peekAccountPayload(id: string): AccountPayload | undefined {
  return mem.get(id);
}

/** Called with every newer payload for `id` (a sync, a refresh). Returns the unsubscribe. */
export function onAccountPayload(id: string, fn: (p: AccountPayload) => void): () => void {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(id);
  };
}

let loaded: Promise<void> | null = null;

/** Pull the whole store into memory once per session, so every open after it is synchronous. */
function loadMemory(): Promise<void> {
  if (!loaded) {
    loaded = all<AccountPayload>("snap").then((rows) => {
      for (const { key: k, value } of rows) {
        const id = k.startsWith("acct:") ? k.slice(5) : null;
        if (id && !mem.has(id)) mem.set(id, value);
      }
    });
  }
  return loaded;
}

async function fetchOne(id: string): Promise<AccountPayload | null> {
  const res = await apiFetch(`/api/account/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  const j = (await res.json()) as { ok?: boolean; payload?: AccountPayload };
  if (!res.ok || !j.ok || !j.payload) throw new Error("read");
  return j.payload;
}

export type PayloadResult = { payload: AccountPayload } | { missing: true } | { offline: true };

/** This client from the phone store only, never the network. */
export async function readStoredAccount(id: string): Promise<AccountPayload | undefined> {
  const hit = mem.get(id) ?? (await get<AccountPayload>("snap", key(id)));
  if (hit && !mem.has(id)) mem.set(id, hit);
  return hit;
}

/** Keep a payload the server just handed over some other way (the full page's own render). */
export async function storeAccount(id: string, p: AccountPayload): Promise<void> {
  remember(id, p);
  await put("snap", key(id), p);
}

/** From the phone store, else from the server (and then kept). */
export async function getAccountPayload(id: string): Promise<PayloadResult> {
  const hit = await readStoredAccount(id);
  if (hit) return { payload: hit };
  try {
    const p = await fetchOne(id);
    if (!p) return { missing: true };
    remember(id, p);
    await put("snap", key(id), p);
    return { payload: p };
  } catch {
    return { offline: true };
  }
}

/**
 * Refetch one client and write it into the store. Call after the app changes
 * that client (TierButton, a visit note HubSpot confirmed). Resolves to the
 * new payload, or null when the server could not be reached (the stored copy
 * stays as it was).
 */
export async function refreshAccount(id: string): Promise<AccountPayload | null> {
  try {
    const p = await fetchOne(id);
    if (!p) return null;
    remember(id, p);
    await put("snap", key(id), p);
    return p;
  } catch {
    return null;
  }
}

/** Patch the stored copy in place, for a change the screen already shows. */
export async function patchAccount(id: string, fn: (p: AccountPayload) => AccountPayload): Promise<void> {
  const cur = mem.get(id) ?? (await get<AccountPayload>("snap", key(id)));
  if (!cur) return;
  const next = fn(cur);
  mem.set(id, next);
  await put("snap", key(id), next);
}

let inflight: Promise<boolean> | null = null;
let lastFailAt = 0;

/** Download the whole book when the last download is over 11 hours old (or `force`). Single-flight. */
export function syncSnapshot({ force = false }: { force?: boolean } = {}): Promise<boolean> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      await loadMemory();
      if (!force) {
        const meta = await get<SnapMeta>("snap", "meta");
        if (meta && Date.now() - Date.parse(meta.syncedAt) < STALE_MS) return false;
        if (Date.now() - lastFailAt < RETRY_GAP_MS) return false;
      }
      const res = await apiFetch("/api/account/snapshot", { cache: "no-store" });
      const j = (await res.json()) as { ok?: boolean; builtAt?: string; accounts?: Record<string, AccountPayload> };
      if (!res.ok || !j.ok || !j.accounts) throw new Error("snapshot");
      const ids = Object.keys(j.accounts);
      const meta: SnapMeta = { syncedAt: new Date().toISOString(), builtAt: j.builtAt ?? "", count: ids.length };
      await replaceAll("snap", [...ids.map((id) => [key(id), j.accounts![id]] as [string, unknown]), ["meta", meta]]);
      for (const id of ids) remember(id, j.accounts[id]);
      await fetchTodaysStops();
      return true;
    } catch {
      lastFailAt = Date.now();
      return false;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Today's route stops outside the book are not in the snapshot; fetch them one by one. */
async function fetchTodaysStops(): Promise<void> {
  try {
    const res = await apiFetch("/api/account/live", { cache: "no-store" });
    const j = (await res.json()) as { ok?: boolean; routeDraftByDay?: Record<string, RouteDraftEntry[]> };
    if (!res.ok || !j.ok) return;
    const today = j.routeDraftByDay?.[laTodayIso()] ?? [];
    const missing = today.filter((e): e is string => typeof e === "string" && !mem.has(e));
    for (const id of missing) await getAccountPayload(id);
  } catch {
    /* the next sync tries again */
  }
}
