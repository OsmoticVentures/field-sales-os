/**
 * The idempotency guard every write route in this app calls. New to this
 * repo, not ported: the old app never needed one (it wrote once, filed by
 * hand). Here it exists so the offline queue (a later port) can replay a
 * queued write after signal returns without risking a second row.
 *
 * A write route calls this once, wrapping the actual filing call:
 *
 *   const key = idempotencyKey(req, form);
 *   if (!key) return Response.json({ ok: false, error: "Idempotency-Key is required." }, { status: 400 });
 *   const { result, replayed } = await withIdempotency(`hours:${key}`, () => fileHours(input));
 *
 * STORAGE, TWO TIERS. An in-memory map always guards correctly within one
 * warm server instance (which is what a manual retry or a same-session
 * replay hits), verifiable with no external dependency, that's the "local
 * stub" this repo's PORTING.md points at for a build-time check. When
 * NB_SUPABASE_URL / NB_SUPABASE_SERVICE_ROLE_KEY are set (the same project
 * lib/core/devices.ts already reads), it also durably persists the key to a
 * `nb_idempotency_keys` table so a cold start or a different instance
 * catches the replay too. THAT TABLE DOES NOT EXIST YET in the shared
 * Supabase project; until it's created (see PORTING.md for the exact DDL),
 * the guard quietly runs on the in-memory tier alone, which is correct but
 * not durable across a cold start. This is stated here, not hidden: a
 * Supabase read/write failure never blocks or duplicates a write, it only
 * narrows the guard back to the memory tier for that call.
 */
import "server-only";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const configured = (): boolean => Boolean(SB_URL && SB_KEY);

const memory = new Map<string, unknown>();

export type IdempotencyOutcome<T> = { result: T; replayed: boolean };

export async function withIdempotency<T>(key: string, fn: () => Promise<T>): Promise<IdempotencyOutcome<T>> {
  if (memory.has(key)) return { result: memory.get(key) as T, replayed: true };

  if (configured()) {
    const existing = await sbGet(key);
    if (existing !== undefined) {
      memory.set(key, existing);
      return { result: existing as T, replayed: true };
    }
  }

  const result = await fn();
  memory.set(key, result);
  if (configured()) await sbPut(key, result); // best effort; see module comment
  return { result, replayed: false };
}

/** Reads the header first (the shape the offline queue and any client will
 *  use), a multipart form field second, for the routes that take a photo. */
export function idempotencyKey(req: Request, form?: FormData): string | null {
  const header = req.headers.get("idempotency-key");
  if (header) return header.slice(0, 200);
  if (form) {
    const field = form.get("idempotency_key");
    if (typeof field === "string" && field) return field.slice(0, 200);
  }
  return null;
}

async function sbGet(key: string): Promise<unknown> {
  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/nb_idempotency_keys?id=eq.${encodeURIComponent(key)}&select=response`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, cache: "no-store" },
    );
    if (!res.ok) return undefined; // table absent or unreachable: fall back to memory tier
    const rows = (await res.json()) as { response: unknown }[];
    return rows.length ? rows[0].response : undefined;
  } catch {
    return undefined;
  }
}

async function sbPut(key: string, response: unknown): Promise<void> {
  try {
    await fetch(`${SB_URL}/rest/v1/nb_idempotency_keys`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ id: key, response }),
    });
  } catch {
    // Best effort. A failed durable write never blocks or duplicates the
    // write already returned to the caller.
  }
}
