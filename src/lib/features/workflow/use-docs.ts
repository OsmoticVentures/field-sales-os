"use client";

/**
 * The Workflow screen's client store: one board's documents, read once on
 * mount, written through /api/workflow, which answers every write with the
 * board's full list. Writes apply optimistically and roll back on failure.
 *
 * Cmd+Z undoes the last write (one stack per board, 50 deep, gone on
 * reload), the same shape as the roadmap's undo.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/core/api";
import type { Board, Item } from "./types";

type Undo<T> = { id: string; before: T | null };

export type Docs<T> = {
  items: Item<T>[];
  loading: boolean;
  /** The last failed write, shown in place; cleared by the next success. */
  error: string | null;
  add: (data: T) => Promise<string | null>;
  set: (id: string, data: T) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  undo: () => Promise<void>;
  canUndo: boolean;
};

export function useDocs<T extends object>(board: Board): Docs<T> {
  const [items, setItems] = useState<Item<T>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const undoRef = useRef<Undo<T>[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  useEffect(() => {
    let live = true;
    apiFetch(`/api/workflow?board=${board}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        if (j?.ok) setItems(j.items as Item<T>[]);
        else setError(j?.error ?? "Could not load.");
      })
      .catch(() => live && setError("Could not load."))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [board]);

  const send = useCallback(
    async (method: string, body: Record<string, unknown>): Promise<{ id?: string } | null> => {
      try {
        const res = await apiFetch("/api/workflow", {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ board, ...body }),
        });
        const j = await res.json().catch(() => null);
        if (!res.ok || !j?.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
        setItems(j.items as Item<T>[]);
        setError(null);
        return j as { id?: string };
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save.");
        return null;
      }
    },
    [board],
  );

  const remember = useCallback((u: Undo<T>) => {
    undoRef.current.push(u);
    if (undoRef.current.length > 50) undoRef.current.shift();
    setCanUndo(true);
  }, []);

  const add = useCallback(
    async (data: T) => {
      const j = await send("POST", { data });
      if (j?.id) remember({ id: j.id, before: null });
      return j?.id ?? null;
    },
    [send, remember],
  );

  const set = useCallback(
    async (id: string, data: T) => {
      const prev = itemsRef.current;
      const before = prev.find((x) => x.id === id)?.data ?? null;
      setItems(prev.map((x) => (x.id === id ? { id, data } : x)));
      const j = await send("PUT", { id, data });
      if (!j) { setItems(prev); return false; }
      remember({ id, before });
      return true;
    },
    [send, remember],
  );

  const remove = useCallback(
    async (id: string) => {
      const prev = itemsRef.current;
      const before = prev.find((x) => x.id === id)?.data ?? null;
      setItems(prev.filter((x) => x.id !== id));
      const j = await send("DELETE", { id });
      if (!j) { setItems(prev); return false; }
      remember({ id, before });
      return true;
    },
    [send, remember],
  );

  const undo = useCallback(async () => {
    const u = undoRef.current.pop();
    setCanUndo(undoRef.current.length > 0);
    if (!u) return;
    if (u.before) await send("PUT", { id: u.id, data: u.before });
    else await send("DELETE", { id: u.id });
  }, [send]);

  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      !!(t instanceof Element && t.closest("input,textarea,select,[contenteditable]"));
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing(e.target)) {
        e.preventDefault();
        void undo();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [undo]);

  return { items, loading, error, add, set, remove, undo, canUndo };
}
