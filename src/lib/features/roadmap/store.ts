/**
 * The Marketing screen's two roadmaps, one row per project in nb_roadmap_items
 * (supabase/0011_roadmap_items.sql). A project is a JSON document (title,
 * link, priority, pos, placed, budget, stages) that the screen reads and writes
 * whole, so this file only moves documents, it never interprets one.
 *
 * Every write answers with the board's full list, so the screen repaints from
 * what the database now holds without a second request. At 60 rows a board
 * that is a few kilobytes.
 */
import "server-only";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

export const BOARDS = ["projects", "sales"] as const;
export type Board = (typeof BOARDS)[number];
export const MAX_ITEMS = 60;

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
  if (!res.ok) throw new Error(`nb_roadmap_items -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

export async function list(board: Board): Promise<Item[]> {
  const res = await rest(`nb_roadmap_items?board=eq.${board}&select=id,data&order=id`);
  return (await res.json()) as Item[];
}

async function one(board: Board, id: string): Promise<Item | null> {
  const res = await rest(`nb_roadmap_items?board=eq.${board}&id=eq.${encodeURIComponent(id)}&select=id,data`);
  return ((await res.json()) as Item[])[0] ?? null;
}

/** Replace a project whole, creating it when absent. Undo uses this to bring
 *  a deleted project back under its own id. */
export async function put(board: Board, id: string, data: Record<string, unknown>): Promise<void> {
  await rest("nb_roadmap_items?on_conflict=board,id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ board, id, data, updated_at: new Date().toISOString() }),
  });
}

/** Merge top-level fields into a project, the way the artifact's update did. */
export async function merge(board: Board, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const cur = await one(board, id);
  if (!cur) return false;
  await rest(`nb_roadmap_items?board=eq.${board}&id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ data: { ...cur.data, ...patch }, updated_at: new Date().toISOString() }),
  });
  return true;
}

export async function remove(board: Board, id: string): Promise<void> {
  await rest(`nb_roadmap_items?board=eq.${board}&id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
