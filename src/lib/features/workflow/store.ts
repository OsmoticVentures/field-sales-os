/**
 * The Workflow screen's documents, one row per map or folder tree in
 * nb_workflow_items (supabase/0012_workflow_items.sql). A document is read
 * and written whole, the same shape as the roadmap (lib/features/roadmap/
 * store.ts), so this file only moves documents, it never interprets one.
 *
 * Every write answers with the board's full list, so the screen repaints
 * from what the database now holds without a second request. At 20 rows a
 * board and 60 KB a row that is at most a megabyte, in practice a few KB.
 */
import "server-only";
import { BOARDS, type Board } from "./types";

export { BOARDS, MAX_DOCS, newId, type Board } from "./types";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const TABLE = "nb_workflow_items";

export type Item = { id: string; data: Record<string, unknown> };

const isBoard = (b: unknown): b is Board => (BOARDS as readonly unknown[]).includes(b);
export const boardOf = (b: unknown): Board | null => (isBoard(b) ? b : null);
export const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(id);

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  if (!SB_URL || !SB_KEY) throw new Error("NB Supabase is not configured.");
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${TABLE} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

export async function list(board: Board): Promise<Item[]> {
  const res = await rest(`${TABLE}?board=eq.${board}&select=id,data&order=id`);
  return (await res.json()) as Item[];
}

/** Replace a document whole, creating it when absent. Undo uses this to
 *  bring a deleted document back under its own id. */
export async function put(board: Board, id: string, data: Record<string, unknown>): Promise<void> {
  await rest(`${TABLE}?on_conflict=board,id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ board, id, data, updated_at: new Date().toISOString() }),
  });
}

export async function remove(board: Board, id: string): Promise<void> {
  await rest(`${TABLE}?board=eq.${board}&id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}
