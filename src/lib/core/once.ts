/**
 * Run a side effect once per key, across a retry, a double tap, and two
 * server instances. The writes that follow an AI step (a filed touchpoint,
 * a HubSpot note, an outbound draft) go through this, keyed by what they are
 * (the rep, the account, the note, the day), not by a client-made header,
 * so two taps that minted two different headers still file one row.
 *
 * HOW. A claim row is inserted in nb_idempotency_keys (agency migration
 * 0085) under the key. The primary key makes the insert atomic: exactly one
 * caller gets 201, everyone else 409.
 *   - The winner runs the write, then stores its result on the row ("done").
 *     A write that throws releases the claim, so the next try runs fresh.
 *   - A loser reads the row: "done" replays the stored result; "pending"
 *     waits a few seconds for it, then gives up with `held`, never writes.
 *   - A "pending" claim older than its lease is a crashed first try: one
 *     caller takes it over with a compare-and-set on created_at.
 * Same-instance callers share one in-flight promise before any of that.
 * When the table cannot be reached the guard narrows to the in-flight tier
 * alone, which is what the app had before: never a blocked write.
 *
 * Pure (no "server-only", no env): tests/once.test.mts runs it against a
 * fake PostgREST. The server wiring is ./once-server.ts.
 */

export type ClaimRow = { state: "pending" | "done"; result?: unknown; at: number };

export interface ClaimStore {
  /** "claimed" when this call created the row, "exists" when it was already there. */
  insert(key: string, row: ClaimRow): Promise<"claimed" | "exists" | "unavailable">;
  /** `version` is created_at exactly as the store printed it (microseconds
   *  and all), so a compare-and-set on it matches. */
  read(key: string): Promise<{ row: ClaimRow; createdAt: number; version: string } | null | "unavailable">;
  /** Compare-and-set takeover of a stale pending claim. */
  takeover(key: string, version: string, row: ClaimRow): Promise<boolean>;
  complete(key: string, row: ClaimRow): Promise<void>;
  release(key: string): Promise<void>;
}

export class Held extends Error {
  constructor() {
    super("This is already being filed. Try again in a moment.");
    this.name = "Held";
  }
}

export type OnceOptions = {
  /** A pending claim older than this is a crashed attempt. Longer than the
   *  slowest route that writes (maxDuration 60s). */
  leaseMs?: number;
  /** How long a second caller waits for the first to finish. */
  waitMs?: number;
};

export type OnceOutcome<T> = { result: T; replayed: boolean };

export function makeOnce(store: ClaimStore | null, clock: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const now = clock.now ?? Date.now;
  const sleep = clock.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const inflight = new Map<string, Promise<OnceOutcome<unknown>>>();

  async function durable<T>(key: string, fn: () => Promise<T>, opts: Required<OnceOptions>): Promise<OnceOutcome<T>> {
    if (!store) return { result: await fn(), replayed: false };
    const mine: ClaimRow = { state: "pending", at: now() };
    let got = await store.insert(key, mine);

    if (got === "exists") {
      const until = now() + opts.waitMs;
      for (;;) {
        const seen = await store.read(key);
        if (seen === "unavailable") break; // narrow to the in-flight tier
        if (seen === null) {
          // Released between our insert and read: race for it once more.
          got = await store.insert(key, { state: "pending", at: now() });
          if (got !== "exists") break;
          continue;
        }
        if (seen.row.state === "done") return { result: seen.row.result as T, replayed: true };
        if (now() - seen.createdAt > opts.leaseMs) {
          if (await store.takeover(key, seen.version, { state: "pending", at: now() })) {
            got = "claimed";
            break;
          }
          continue;
        }
        if (now() >= until) throw new Held();
        await sleep(500);
      }
    }

    let result: T;
    try {
      result = await fn();
    } catch (err) {
      if (got === "claimed") await store.release(key).catch(() => {});
      throw err;
    }
    if (got === "claimed") await store.complete(key, { state: "done", result, at: now() }).catch(() => {});
    return { result, replayed: false };
  }

  return async function once<T>(key: string, fn: () => Promise<T>, options: OnceOptions = {}): Promise<OnceOutcome<T>> {
    const opts = { leaseMs: options.leaseMs ?? 120_000, waitMs: options.waitMs ?? 8_000 };
    const running = inflight.get(key) as Promise<OnceOutcome<T>> | undefined;
    if (running) return running.then((o) => ({ result: o.result, replayed: true }));
    const p = durable(key, fn, opts);
    inflight.set(key, p);
    try {
      return await p;
    } finally {
      inflight.delete(key);
    }
  };
}

/**
 * The claim store over PostgREST, on nb_idempotency_keys(id, response,
 * created_at). Rows are bounded by that table's own 30-day prune trigger.
 * Every call is a single-row write or a single-row read by primary key.
 */
export function postgrestClaimStore(cfg: { url: string; key: string; fetch?: typeof fetch; prefix?: string }): ClaimStore {
  const f = cfg.fetch ?? fetch;
  const table = `${cfg.url}/rest/v1/nb_idempotency_keys`;
  const id = (k: string) => `${cfg.prefix ?? "once:"}${k}`;
  const headers = (extra: Record<string, string> = {}) => ({
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    "Content-Type": "application/json",
    ...extra,
  });
  const byId = (k: string) => `${table}?id=eq.${encodeURIComponent(id(k))}`;

  return {
    async insert(k, row) {
      try {
        const res = await f(table, {
          method: "POST",
          headers: headers({ Prefer: "return=minimal" }),
          body: JSON.stringify({ id: id(k), response: row }),
          cache: "no-store",
        });
        if (res.status === 201 || res.status === 200 || res.status === 204) return "claimed";
        if (res.status === 409) return "exists";
        return "unavailable";
      } catch {
        return "unavailable";
      }
    },
    async read(k) {
      try {
        const res = await f(`${byId(k)}&select=response,created_at`, { headers: headers(), cache: "no-store" });
        if (!res.ok) return "unavailable";
        const rows = (await res.json()) as { response: ClaimRow; created_at: string }[];
        if (!rows.length) return null;
        return { row: rows[0].response, createdAt: new Date(rows[0].created_at).getTime(), version: rows[0].created_at };
      } catch {
        return "unavailable";
      }
    },
    async takeover(k, version, row) {
      try {
        const res = await f(`${byId(k)}&created_at=eq.${encodeURIComponent(version)}`, {
          method: "PATCH",
          headers: headers({ Prefer: "return=representation" }),
          body: JSON.stringify({ response: row, created_at: new Date(row.at).toISOString() }),
          cache: "no-store",
        });
        if (!res.ok) return false;
        const rows = (await res.json()) as unknown[];
        return rows.length === 1;
      } catch {
        return false;
      }
    },
    async complete(k, row) {
      await f(byId(k), {
        method: "PATCH",
        headers: headers({ Prefer: "return=minimal" }),
        body: JSON.stringify({ response: row }),
        cache: "no-store",
      });
    },
    async release(k) {
      // Only ever the claim row this caller inserted seconds ago, by key.
      await f(byId(k), { method: "DELETE", headers: headers({ Prefer: "return=minimal" }), cache: "no-store" });
    },
  };
}
