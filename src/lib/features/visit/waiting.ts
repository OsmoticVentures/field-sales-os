/**
 * A copy, on the server, of every phone note that waits for the laptop
 * (nb_waiting_notes, migration 0113). The phone still holds the note and still
 * retries it; this copy lets the Mac file it the moment the Mac is back online,
 * whether or not the app is open on the phone. The Mac files it under the
 * phone's own idempotency key, so the phone's next retry is replayed the filed
 * answer and never files it a second time.
 *
 * Every call here is best effort: a Supabase miss never fails or blocks the
 * phone's own path, it only leaves the note to the phone's retry.
 */
import "server-only";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

export type WaitingNote = {
  key: string;
  text: string;
  account_id_hint: string | null;
  kind_override: "meeting" | "call" | "email" | "field_note" | null;
  force_new_account: boolean;
  occurred_at: string | null;
  status: "waiting" | "filing" | "filed" | "needs_account" | "failed";
};

async function sb(path: string, init: RequestInit = {}): Promise<Response | null> {
  if (!SB_URL || !SB_KEY) return null;
  try {
    return await fetch(`${SB_URL}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...init.headers },
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    return null;
  }
}

/** Keep the note. A retry of the same key refreshes its fields and leaves its
 *  status alone, so a note the Mac is filing is never put back to waiting. */
export async function keepWaiting(n: Omit<WaitingNote, "status">): Promise<void> {
  await sb("nb_waiting_notes?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ ...n, updated_at: new Date().toISOString() }),
  });
}

/** Discarded or taken back to edit on the phone: the Mac must not file it.
 *  Removes the note under its own key and every key derived from it
 *  (`<id>:<picked account>`), unless it is already being filed or filed. */
export async function withdrawWaiting(id: string): Promise<void> {
  const safe = id.replace(/[^A-Za-z0-9-]/g, "");
  if (!safe) return;
  await sb(`nb_waiting_notes?or=(key.eq.${safe},key.like.${safe}:*)&status=eq.waiting`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

export async function getWaiting(key: string): Promise<WaitingNote | null> {
  const res = await sb(`nb_waiting_notes?key=eq.${encodeURIComponent(key)}&select=*`);
  if (!res?.ok) return null;
  const [row] = (await res.json()) as WaitingNote[];
  return row ?? null;
}

export async function settleWaiting(
  key: string,
  status: "filed" | "needs_account" | "failed" | "waiting",
  extra: { error?: string | null; touchpoint_id?: string | null } = {},
): Promise<void> {
  await sb(`nb_waiting_notes?key=eq.${encodeURIComponent(key)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status, ...extra, updated_at: new Date().toISOString() }),
  });
}
