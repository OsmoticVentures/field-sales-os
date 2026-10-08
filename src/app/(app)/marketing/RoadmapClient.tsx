"use client";

/**
 * Mounts the two roadmaps (lib/features/roadmap/board.ts) and hands them a
 * database with the shape they were written against: collection(c) with
 * onSnapshot, add, and doc(id).update / set / delete. Each call goes to
 * /api/marketing, which answers every write with the board's full list, and
 * that list is what the board repaints from. One read per board on load, one
 * round trip per write, no polling.
 */

import { useEffect } from "react";
import { apiFetch } from "@/lib/core/api";
import { mountRoadmaps } from "../../../lib/features/roadmap/board";
import "./roadmap.css";

type Item = { id: string; data: Record<string, unknown> };
type Snap = { docs: { id: string; data: () => Record<string, unknown> }[] };

function makeDb() {
  const listeners: Record<string, ((s: Snap) => void)[]> = {};
  const fail: Record<string, (() => void)[]> = {};
  const emit = (board: string, items: Item[]) => {
    const snap: Snap = { docs: items.map((it) => ({ id: it.id, data: () => JSON.parse(JSON.stringify(it.data)) })) };
    (listeners[board] ?? []).forEach((cb) => cb(snap));
  };
  const send = async (method: string, body: Record<string, unknown>) => {
    const res = await apiFetch("/api/marketing", {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
    emit(String(body.board), j.items as Item[]);
    return j as { id?: string };
  };
  return {
    collection(board: string) {
      return {
        onSnapshot(cb: (s: Snap) => void, onErr?: () => void) {
          (listeners[board] ??= []).push(cb);
          if (onErr) (fail[board] ??= []).push(onErr);
          apiFetch(`/api/marketing?board=${board}`, { cache: "no-store" })
            .then((r) => r.json())
            .then((j) => { if (j?.ok) emit(board, j.items); else (fail[board] ?? []).forEach((f) => f()); })
            .catch(() => (fail[board] ?? []).forEach((f) => f()));
          return () => { listeners[board] = (listeners[board] ?? []).filter((x) => x !== cb); };
        },
        async add(data: Record<string, unknown>) {
          const j = await send("POST", { board, data });
          return { id: j.id as string };
        },
        doc(id: string) {
          return {
            update: (data: Record<string, unknown>) => send("PATCH", { board, id, data }).then(() => undefined),
            set: (data: Record<string, unknown>) => send("PUT", { board, id, data }).then(() => undefined),
            delete: () => send("DELETE", { board, id }).then(() => undefined),
          };
        },
      };
    },
  };
}

export function RoadmapClient() {
  useEffect(() => mountRoadmaps(makeDb(), true), []);

  return (
    <div className="rm">
      <div className="wrap">
        <header>
          <h1>NutriBiotic Marketing Roadmap</h1>
        </header>
        <div className="board" id="board-mk" />

        <header className="part">
          <h1>Sales Strategy Roadmap</h1>
        </header>
        <div className="board" id="board-sl" />
      </div>
    </div>
  );
}
