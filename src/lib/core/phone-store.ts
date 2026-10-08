/**
 * THE PHONE STORE. Durable key/value storage in the phone's IndexedDB, so
 * what the app has downloaded survives closing it, a dead zone, and a cold
 * start. Everything on the phone that must outlive a tab goes through here:
 *
 *  - "snap"   the twice-daily download of every client's data (see
 *             phone-sync.ts), one record per client, plus the sync stamp;
 *  - "reads"  the last good answer of the read endpoints a screen paints
 *             from (search book, route map), see api.ts;
 *  - "outbox" every visit note until HubSpot has confirmed it (outbox.ts);
 *  - "writeq" every other write made with no signal, until it lands
 *             (writeq.ts).
 *
 * ONE REP'S DATA AT A TIME. "snap" and "reads" keys are stored under the
 * signed-in rep ("<rep>|<key>") and read back only under that rep, and
 * adoptRep() (rep.ts) wipes both stores whenever a different rep signs in.
 * Queued writes are never wiped (that would lose a rep's unsent work): each
 * one names its rep and only that rep's session sends it.
 *
 * Browser-only. Every call resolves, never throws: on a private window or a
 * blocked store it degrades to memory for the session, and `durable()` says
 * which one the caller got, so the outbox can refuse to claim a note is safe
 * when it is not.
 *
 * BOUNDS (agency rule: every append has its bound). "snap" is rewritten
 * whole at each sync, so it never outgrows the book. "reads" holds one record
 * per allowlisted path, and a copy older than a week is never painted.
 * "outbox" and "writeq" are bounded by what is unsent, and an item leaves
 * only when it lands or on a tapped discard.
 */

export type StoreName = "snap" | "reads" | "outbox" | "writeq";

const DB_NAME = "clientos-phone";
const DB_VERSION = 2;
const STORES: StoreName[] = ["snap", "reads", "outbox", "writeq"];

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memory: Record<StoreName, Map<string, unknown>> = { snap: new Map(), reads: new Map(), outbox: new Map(), writeq: new Map() };

/** localStorage: the rep whose data the phone holds now (rep.ts writes it). */
export const REP_KEY = "nb_rep";

/** The rep this phone's data belongs to: set at sign-in and on each /api/me,
 *  null on a fresh browser. */
export function currentRep(): string | null {
  try {
    const rep = localStorage.getItem(REP_KEY);
    if (rep) return rep;
    const me = JSON.parse(localStorage.getItem("nb_me") ?? "null") as { id?: string } | null;
    return me?.id ?? null;
  } catch {
    return null;
  }
}

/** Stores that hold a rep's reads are keyed by rep; the write queues are not
 *  (their items name their rep instead). */
const scoped = (store: StoreName) => store === "snap" || store === "reads";
const prefix = () => `${currentRep() ?? "_"}|`;
const toDisk = (store: StoreName, key: string) => (scoped(store) ? prefix() + key : key);

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
        // Version 1 kept reads with no rep in the key: drop them, the next
        // open downloads the signed-in rep's copy.
        if (e.oldVersion > 0 && e.oldVersion < 2) {
          const tx = req.transaction;
          tx?.objectStore("snap").clear();
          tx?.objectStore("reads").clear();
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  // Ask the phone not to evict this store under storage pressure.
  try {
    void navigator.storage?.persist?.();
  } catch {
    /* best effort */
  }
  return dbPromise;
}

/** True when writes reach the phone's disk, false when they only live in this session. */
export async function durable(): Promise<boolean> {
  return (await open()) !== null;
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        if (!db) return reject(new Error("no-db"));
        try {
          const tx = db.transaction(store, mode);
          const req = fn(tx.objectStore(store));
          // A write resolves when the transaction commits, not when the
          // request is queued: only then is it on the disk.
          if (mode === "readwrite") {
            tx.oncomplete = () => resolve(req.result);
          } else {
            req.onsuccess = () => resolve(req.result);
          }
          tx.onerror = () => reject(tx.error ?? new Error("tx"));
          tx.onabort = () => reject(tx.error ?? new Error("abort"));
        } catch (e) {
          reject(e);
        }
      }),
  );
}

export async function put(store: StoreName, key: string, value: unknown): Promise<boolean> {
  const k = toDisk(store, key);
  memory[store].set(k, value);
  try {
    await run(store, "readwrite", (s) => s.put(value, k));
    return true;
  } catch {
    return false;
  }
}

export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  const k = toDisk(store, key);
  try {
    const v = (await run(store, "readonly", (s) => s.get(k))) as T | undefined;
    if (v !== undefined) return v;
  } catch {
    /* fall through to memory */
  }
  return memory[store].get(k) as T | undefined;
}

export async function del(store: StoreName, key: string): Promise<void> {
  const k = toDisk(store, key);
  memory[store].delete(k);
  try {
    await run(store, "readwrite", (s) => s.delete(k));
  } catch {
    /* gone from memory; a disk miss is retried by the caller's next pass */
  }
}

export async function all<T>(store: StoreName): Promise<{ key: string; value: T }[]> {
  if (!scoped(store)) return allRaw<T>(store);
  const p = prefix();
  const rows = await allRaw<T>(store);
  return rows.filter((r) => r.key.startsWith(p)).map((r) => ({ key: r.key.slice(p.length), value: r.value }));
}

async function allRaw<T>(store: StoreName): Promise<{ key: string; value: T }[]> {
  try {
    const db = await open();
    if (!db) throw new Error("no-db");
    return await new Promise((resolve, reject) => {
      const out: { key: string; value: T }[] = [];
      const req = db.transaction(store, "readonly").objectStore(store).openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) {
          out.push({ key: String(c.key), value: c.value as T });
          c.continue();
        } else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [...memory[store].entries()].map(([key, value]) => ({ key, value: value as T }));
  }
}

/** Replace a whole store in one transaction (the twice-daily download).
 *  Clears every rep's entries, not only the signed-in one's. */
export async function replaceAll(store: StoreName, entries: [string, unknown][]): Promise<boolean> {
  entries = entries.map(([k, v]) => [toDisk(store, k), v]);
  memory[store] = new Map(entries);
  try {
    const db = await open();
    if (!db) return false;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, "readwrite");
      const os = tx.objectStore(store);
      os.clear();
      for (const [k, v] of entries) os.put(v, k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}
