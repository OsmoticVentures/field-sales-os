/**
 * THE PHONE STORE. Durable key/value storage in the phone's IndexedDB, so
 * what the app has downloaded survives closing it, a dead zone, and a cold
 * start. Everything on the phone that must outlive a tab goes through here:
 *
 *  - "snap"   the twice-daily download of every client's data (see
 *             phone-sync.ts), one record per client, plus the sync stamp;
 *  - "reads"  the last good answer of the read endpoints a screen paints
 *             from (search book, route map), see api.ts;
 *  - "outbox" every visit note until HubSpot has confirmed it (outbox.ts).
 *
 * Browser-only. Every call resolves, never throws: on a private window or a
 * blocked store it degrades to memory for the session, and `durable()` says
 * which one the caller got, so the outbox can refuse to claim a note is safe
 * when it is not.
 *
 * BOUNDS (agency rule: every append has its bound). "snap" is rewritten
 * whole at each sync, so it never outgrows the book. "reads" holds one record
 * per allowlisted path. "outbox" is bounded by what is unconfirmed, and an
 * item leaves only on confirmation or a tapped discard.
 */

export type StoreName = "snap" | "reads" | "outbox";

const DB_NAME = "clientos-phone";
const DB_VERSION = 1;
const STORES: StoreName[] = ["snap", "reads", "outbox"];

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memory: Record<StoreName, Map<string, unknown>> = { snap: new Map(), reads: new Map(), outbox: new Map() };

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
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
  memory[store].set(key, value);
  try {
    await run(store, "readwrite", (s) => s.put(value, key));
    return true;
  } catch {
    return false;
  }
}

export async function get<T>(store: StoreName, key: string): Promise<T | undefined> {
  try {
    const v = (await run(store, "readonly", (s) => s.get(key))) as T | undefined;
    if (v !== undefined) return v;
  } catch {
    /* fall through to memory */
  }
  return memory[store].get(key) as T | undefined;
}

export async function del(store: StoreName, key: string): Promise<void> {
  memory[store].delete(key);
  try {
    await run(store, "readwrite", (s) => s.delete(key));
  } catch {
    /* gone from memory; a disk miss is retried by the caller's next pass */
  }
}

export async function all<T>(store: StoreName): Promise<{ key: string; value: T }[]> {
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

/** Replace a whole store in one transaction (the twice-daily download). */
export async function replaceAll(store: StoreName, entries: [string, unknown][]): Promise<boolean> {
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
