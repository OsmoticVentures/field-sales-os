/**
 * PIN lockout shared by every serverless instance (nb_pin_attempts, migration
 * 20261008090200). Two counters: one per address (five tries, then fifteen
 * minutes), and one ceiling across every address, so spreading guesses over
 * many addresses still hits a wall.
 *
 * If the database cannot be reached, the old in-memory counter in session.ts
 * answers instead: a slower guesser is still slowed, and a rep is never locked
 * out by an outage.
 */
import "server-only";
import { LOCKOUT_MAX, LOCKOUT_MINUTES, lockRemainingMs, registerFailure, registerSuccess } from "./session";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const GLOBAL_KEY = "global";
const GLOBAL_MAX = 30;

export type LockState = { lockedMs: number };
export type FailState = { locked: boolean; left: number };

async function rpc<T>(fn: string, body: unknown): Promise<T> {
  if (!SB_URL || !SB_KEY) throw new Error("unconfigured");
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`rpc ${fn} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** A short, one-way name for the caller's address. The address itself is never stored. */
export async function addressKey(h: Headers): Promise<string> {
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)));
  return "ip:" + Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function lockState(key: string): Promise<LockState> {
  try {
    const seconds = await rpc<number>("nb_pin_lock_remaining", { p_keys: [key, GLOBAL_KEY] });
    return { lockedMs: Math.max(0, Number(seconds) || 0) * 1000 };
  } catch {
    return { lockedMs: lockRemainingMs() };
  }
}

export async function recordFailure(key: string): Promise<FailState> {
  try {
    type Row = { attempts_left: number; locked_seconds: number };
    const [mine, all] = await Promise.all([
      rpc<Row[]>("nb_pin_fail", { p_key: key, p_max: LOCKOUT_MAX, p_minutes: LOCKOUT_MINUTES }),
      rpc<Row[]>("nb_pin_fail", { p_key: GLOBAL_KEY, p_max: GLOBAL_MAX, p_minutes: LOCKOUT_MINUTES }),
    ]);
    const locked = (mine[0]?.locked_seconds ?? 0) > 0 || (all[0]?.locked_seconds ?? 0) > 0;
    return { locked, left: locked ? 0 : (mine[0]?.attempts_left ?? 0) };
  } catch {
    return registerFailure();
  }
}

export async function recordSuccess(key: string): Promise<void> {
  registerSuccess();
  try {
    await rpc<null>("nb_pin_success", { p_key: key });
  } catch {
    // Nothing to undo: an uncleared count simply ages out of its window.
  }
}
