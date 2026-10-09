"use client";

/**
 * The folder tree designer behind a workflow map: one row per Drive folder
 * with its name, its one-line purpose and the step ids that read or write
 * it. The tree is a controlled document: every committed edit hands a new
 * tree to onChange and nothing here mutates the one that came in.
 *
 * Decisions: the root is the top row, renamable but fixed in place. A row
 * moves structurally (up, down, indent, outdent) from its actions and keys,
 * or by dragging its grip, which reparents by depth as well as position; a
 * 2px line marks the drop and the rows between part on the shared spring.
 * Delete never asks in a dialog: a folder with children turns its button
 * into a second tap for three seconds, then it reverts.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import { runSpring } from "../../../lib/core/spring";
import { Ico, ghostBtn, inputCls, primaryBtn } from "../../../lib/core/ui";
import { MAX_FOLDERS, countFolders, newId, type Folder, type FolderTree } from "../../../lib/features/workflow/types";

const INDENT_WIDE = 24; // px per depth from md up
const INDENT_NARROW = 16; // px per depth on a phone
const GUIDE_X = 22; // px, the center of a disclosure cell, where its guide hangs
const LIFT_SLOP = 6; // px a finger may wander before a drag lifts the row
const CONFIRM_MS = 3000;
const LIMIT_MS = 3000;

const wideQuery = "(min-width: 768px)";
const isWide = () => window.matchMedia(wideQuery).matches;
const subscribeWide = (notify: () => void) => {
  const mq = window.matchMedia(wideQuery);
  mq.addEventListener("change", notify);
  return () => mq.removeEventListener("change", notify);
};
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Tree helpers, all pure: a changed branch is rebuilt, an untouched one is
   the same object, so a no-op edit never emits. */

function findNode(f: Folder, id: string): Folder | null {
  if (f.id === id) return f;
  for (const c of f.children) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

function findParent(f: Folder, id: string): { parent: Folder; index: number } | null {
  const index = f.children.findIndex((c) => c.id === id);
  if (index >= 0) return { parent: f, index };
  for (const c of f.children) {
    const hit = findParent(c, id);
    if (hit) return hit;
  }
  return null;
}

function replaceNode(f: Folder, id: string, fn: (n: Folder) => Folder): Folder {
  if (f.id === id) return fn(f);
  let changed = false;
  const children = f.children.map((c) => {
    const r = replaceNode(c, id, fn);
    if (r !== c) changed = true;
    return r;
  });
  return changed ? { ...f, children } : f;
}

function removeNode(f: Folder, id: string): Folder {
  const hit = findParent(f, id);
  if (!hit) return f;
  return replaceNode(f, hit.parent.id, (p) => ({ ...p, children: p.children.filter((c) => c.id !== id) }));
}

function insertNode(f: Folder, parentId: string, index: number, node: Folder): Folder {
  return replaceNode(f, parentId, (p) => {
    const children = p.children.slice();
    children.splice(index, 0, node);
    return { ...p, children };
  });
}

type Row = { folder: Folder; depth: number; parentId: string | null };

function flatten(root: Folder, hidden: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (f: Folder, depth: number, parentId: string | null) => {
    rows.push({ folder: f, depth, parentId });
    if (!hidden.has(f.id)) for (const c of f.children) walk(c, depth + 1, f.id);
  };
  walk(root, 0, null);
  return rows;
}

const blank = (): Folder => ({ id: newId(), name: "New folder", children: [] });

/* Drag bookkeeping, held in a ref for the length of one pointer. */

type Rect = { id: string; top: number; height: number; depth: number };
type Session = {
  id: string;
  depth: number;
  pointerId: number;
  startX: number; // client px
  startY: number; // page px
  lifted: boolean;
  reduced: boolean;
  rects: Rect[]; // every visible row but the lifted one, in order
  self: { top: number; height: number };
  orig: number; // the lifted row's slot, as a gap index in rects
  g: number; // the current gap: insert before rects[g]
  dropDepth: number;
  dy: number;
  vel: number;
  lastT: number;
  landing: boolean;
  stop: (() => void) | null;
};
type Shift = { v: number; target: number; stop: (() => void) | null; lastV: number; lastT: number };

/** Where a gap at depth d lands in the tree: the nearest row above at d - 1
 *  is the parent, the rows at d between it and the gap are the siblings before. */
function resolveDrop(rects: Rect[], g: number, d: number): { parentId: string; index: number } {
  let k = g - 1;
  let index = 0;
  for (; k > 0; k--) {
    if (rects[k].depth === d - 1) break;
    if (rects[k].depth === d) index++;
  }
  return { parentId: rects[k].id, index };
}

function gapTop(s: Session): number {
  if (s.g < s.orig) return s.rects[s.g].top;
  if (s.g > s.orig) return s.rects[s.g - 1].top + s.rects[s.g - 1].height - s.self.height;
  return s.self.top;
}

const liftTransform = (dy: number) => `translate3d(0, ${dy}px, 0) scale(1.01)`;

/* Icons this screen needs beyond ui.tsx, inline. */

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <path d="M2.2 4.8c0-.7.5-1.2 1.2-1.2h2.9l1.5 1.6h4.9c.7 0 1.2.5 1.2 1.2v5.2c0 .7-.5 1.2-1.2 1.2H3.4c-.7 0-1.2-.5-1.2-1.2V4.8Z" />
    </svg>
  );
}

function Triangle({ open }: { open: boolean }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-90" : ""}`}
    >
      <path d="M6 3.6 11 8l-5 4.4Z" fill="currentColor" />
    </svg>
  );
}

function GripIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <circle cx="6" cy="4" r="1" />
      <circle cx="10" cy="4" r="1" />
      <circle cx="6" cy="8" r="1" />
      <circle cx="10" cy="8" r="1" />
      <circle cx="6" cy="12" r="1" />
      <circle cx="10" cy="12" r="1" />
    </svg>
  );
}

const inlineIcons = {
  outdent: <path d="M13 8H3M7 4 3 8l4 4" />,
  indent: <path d="M3 8h10M9 4l4 4-4 4" />,
  trash: <path d="M3 4.4h10M6.2 4.4V3h3.6v1.4M4.2 4.4l.6 8.2h6.4l.6-8.2" />,
};

function Inline({ name }: { name: keyof typeof inlineIcons }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      {inlineIcons[name]}
    </svg>
  );
}

const press = "transition-transform active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100";
const quietBtn = `inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-[13px] text-[#5B6560] hover:text-[#14201B] ${press}`;
const iconBtn = `flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[#5B6560] hover:text-[#14201B] disabled:opacity-30 ${press}`;
const menuItem = `flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[14px] text-[#14201B] hover:bg-[#14201B]/[0.04] disabled:opacity-30 ${press}`;
const reveal = "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";
const popCls = "absolute right-0 top-11 z-30 mt-1 rounded-xl border border-[#E2DFD5] bg-white p-1 shadow-[0_12px_32px_rgba(20,32,27,0.14)]";
const dangerBtn = `${ghostBtn} shrink-0 font-medium text-[#8A2E2E]`;

const deleteLabel = (n: number) => (n === 1 ? "Delete folder" : `Delete ${n} folders`);

type StepOption = { id: string; name?: string };

export function FolderDesigner({
  tree,
  steps,
  onChange,
}: {
  tree: FolderTree;
  steps: { id: string; name: string }[];
  onChange: (next: FolderTree) => void;
}) {
  const root = tree.root;
  const wide = useSyncExternalStore(subscribeWide, isWide, () => true);
  const indent = wide ? INDENT_WIDE : INDENT_NARROW;

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; field: "name" | "purpose" } | null>(null);
  const [draft, setDraft] = useState("");
  const [pickerId, setPickerId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [drag, setDrag] = useState<{ id: string } | null>(null);
  const [drop, setDrop] = useState<{ y: number; depth: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowEls = useRef(new Map<string, HTMLDivElement>());
  const focusNext = useRef<string | null>(null);
  const cancelEdit = useRef(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const limitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const session = useRef<Session | null>(null);
  const shifts = useRef(new Map<string, Shift>());
  const treeRef = useRef(tree);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    treeRef.current = tree;
    onChangeRef.current = onChange;
  });

  const rows = useMemo(() => {
    const hidden = drag ? new Set([...collapsed, drag.id]) : collapsed;
    return flatten(root, hidden);
  }, [root, collapsed, drag]);

  const count = countFolders(root);

  // DOM focus follows a structural move or an add, once the rows have rendered.
  useEffect(() => {
    const id = focusNext.current;
    if (!id) return;
    focusNext.current = null;
    rowEls.current.get(id)?.focus();
  });

  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    el?.focus();
    el?.select();
  }, [editing]);

  useEffect(() => {
    if (!pickerId && !menuId) return;
    const onDown = (e: Event) => {
      if ((e.target as Element | null)?.closest("[data-pop]")) return;
      setPickerId(null);
      setMenuId(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [pickerId, menuId]);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      if (limitTimer.current) clearTimeout(limitTimer.current);
      session.current?.stop?.();
      for (const sh of shifts.current.values()) sh.stop?.();
    },
    [],
  );

  /* Edits */

  const emit = (nextRoot: Folder) => {
    if (nextRoot !== root) onChange({ ...tree, root: nextRoot });
  };
  const update = (id: string, fn: (f: Folder) => Folder) => emit(replaceNode(root, id, fn));

  const expand = (id: string) =>
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const select = (id: string) => {
    setFocusedId(id);
    focusNext.current = id;
  };

  const startEdit = (id: string, field: "name" | "purpose", value: string) => {
    setEditing({ id, field });
    setDraft(value);
  };

  const commitEdit = () => {
    if (!editing) return;
    const { id, field } = editing;
    const value = draft.trim();
    setEditing(null);
    if (field === "name") {
      if (value) update(id, (f) => (f.name === value ? f : { ...f, name: value }));
      return;
    }
    update(id, (f) => {
      if (value) return f.purpose === value ? f : { ...f, purpose: value };
      if (f.purpose === undefined) return f;
      const next = { ...f };
      delete next.purpose;
      return next;
    });
  };

  const roomFor = () => {
    if (count < MAX_FOLDERS) return true;
    setLimitHit(true);
    if (limitTimer.current) clearTimeout(limitTimer.current);
    limitTimer.current = setTimeout(() => setLimitHit(false), LIMIT_MS);
    return false;
  };

  const addChild = (parentId: string) => {
    const parent = findNode(root, parentId);
    if (!parent || !roomFor()) return;
    const f = blank();
    emit(insertNode(root, parentId, parent.children.length, f));
    expand(parentId);
    setMenuId(null);
    select(f.id);
    startEdit(f.id, "name", f.name);
  };

  const addSibling = (id: string) => {
    const hit = findParent(root, id);
    if (!hit) return addChild(root.id);
    if (!roomFor()) return;
    const f = blank();
    emit(insertNode(root, hit.parent.id, hit.index + 1, f));
    select(f.id);
    startEdit(f.id, "name", f.name);
  };

  const moveSibling = (id: string, dir: -1 | 1): boolean => {
    const hit = findParent(root, id);
    if (!hit) return false;
    const to = hit.index + dir;
    if (to < 0 || to >= hit.parent.children.length) return false;
    emit(
      replaceNode(root, hit.parent.id, (p) => {
        const children = p.children.slice();
        const [node] = children.splice(hit.index, 1);
        children.splice(to, 0, node);
        return { ...p, children };
      }),
    );
    setMenuId(null);
    select(id);
    return true;
  };

  const indentRow = (id: string): boolean => {
    const hit = findParent(root, id);
    if (!hit || hit.index === 0) return false;
    const prev = hit.parent.children[hit.index - 1];
    const node = hit.parent.children[hit.index];
    emit(insertNode(removeNode(root, id), prev.id, prev.children.length, node));
    expand(prev.id);
    setMenuId(null);
    select(id);
    return true;
  };

  const outdentRow = (id: string): boolean => {
    const hit = findParent(root, id);
    if (!hit || hit.parent.id === root.id) return false;
    const gp = findParent(root, hit.parent.id);
    if (!gp) return false;
    const node = hit.parent.children[hit.index];
    emit(insertNode(removeNode(root, id), gp.parent.id, gp.index + 1, node));
    setMenuId(null);
    select(id);
    return true;
  };

  const deleteNow = (id: string) => {
    const at = rows.findIndex((r) => r.folder.id === id);
    const fallback = rows[at - 1]?.folder.id ?? root.id;
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmId(null);
    setMenuId(null);
    emit(removeNode(root, id));
    select(fallback);
  };

  const armDelete = (id: string) => {
    setConfirmId(id);
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setConfirmId(null), CONFIRM_MS);
  };

  /** From the button a leaf goes at once; from a key, or with children, it arms first. */
  const requestDelete = (id: string, viaKey: boolean) => {
    if (id === root.id) return;
    if (confirmId === id) return deleteNow(id);
    const f = findNode(root, id);
    if (!f) return;
    if (!viaKey && f.children.length === 0) deleteNow(id);
    else armDelete(id);
  };

  const toggleStep = (id: string, stepId: string) =>
    update(id, (f) => {
      const on = new Set(f.steps ?? []);
      if (on.has(stepId)) on.delete(stepId);
      else on.add(stepId);
      const known = new Set(steps.map((s) => s.id));
      const ordered = [...steps.map((s) => s.id), ...(f.steps ?? []).filter((x) => !known.has(x))].filter((x) => on.has(x));
      if (ordered.length === 0) {
        if (f.steps === undefined) return f;
        const next = { ...f };
        delete next.steps;
        return next;
      }
      return { ...f, steps: ordered };
    });

  /* Keys on a focused row (never while an input inside it has focus). */

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, row: Row, at: number) => {
    const id = row.folder.id;
    if (e.key === "Escape") {
      setPickerId(null);
      setMenuId(null);
      setConfirmId(null);
      return;
    }
    if (e.target !== e.currentTarget) return;
    const isRoot = id === root.id;
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        addSibling(id);
        break;
      case " ":
        e.preventDefault();
        startEdit(id, "name", row.folder.name);
        break;
      case "Tab":
        if (isRoot) return;
        if (e.shiftKey ? outdentRow(id) : indentRow(id)) e.preventDefault();
        break;
      case "ArrowUp":
      case "ArrowDown": {
        e.preventDefault();
        const dir = e.key === "ArrowUp" ? -1 : 1;
        if (e.altKey) {
          if (!isRoot) moveSibling(id, dir);
          break;
        }
        const next = rows[at + dir];
        if (next) rowEls.current.get(next.folder.id)?.focus();
        break;
      }
      case "ArrowLeft":
        e.preventDefault();
        if (row.folder.children.length && !collapsed.has(id)) toggle(id);
        else if (row.parentId) rowEls.current.get(row.parentId)?.focus();
        break;
      case "ArrowRight":
        e.preventDefault();
        if (!row.folder.children.length) break;
        if (collapsed.has(id)) toggle(id);
        else rowEls.current.get(row.folder.children[0].id)?.focus();
        break;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        requestDelete(id, true);
        break;
    }
  };

  /* Drag from the grip: lift after a little travel, track 1:1, part the rows
     between with the spring, land on the gap, then commit. */

  const setShift = (id: string, target: number, reduced: boolean) => {
    const el = rowEls.current.get(id);
    if (!el) return;
    let sh = shifts.current.get(id);
    if (!sh) {
      sh = { v: 0, target: 0, stop: null, lastV: 0, lastT: 0 };
      shifts.current.set(id, sh);
    }
    if (sh.target === target) return;
    sh.target = target;
    sh.stop?.();
    sh.stop = null;
    if (reduced) {
      sh.v = target;
      el.style.transform = target ? `translate3d(0, ${target}px, 0)` : "";
      return;
    }
    const entry = sh;
    const now = performance.now();
    const dt = (now - entry.lastT) / 1000;
    const velocity = dt > 0 && dt < 0.2 ? (entry.v - entry.lastV) / dt : 0;
    entry.stop = runSpring({
      from: entry.v,
      to: target,
      velocity,
      response: 0.32,
      onFrame: (v) => {
        entry.lastV = entry.v;
        entry.lastT = performance.now();
        entry.v = v;
        el.style.transform = `translate3d(0, ${v}px, 0)`;
      },
      onDone: () => {
        entry.stop = null;
      },
    });
  };

  const clearTransforms = (s: Session) => {
    s.stop?.();
    for (const [id, sh] of shifts.current) {
      sh.stop?.();
      rowEls.current.get(id)?.style.removeProperty("transform");
    }
    shifts.current.clear();
    const el = rowEls.current.get(s.id);
    if (el) {
      el.style.removeProperty("transform");
      el.style.removeProperty("will-change");
    }
  };

  const lift = (s: Session) => {
    s.lifted = true;
    flushSync(() => setDrag({ id: s.id }));
    const host = containerRef.current;
    if (!host) return;
    const rects: Rect[] = [];
    host.querySelectorAll<HTMLDivElement>("[data-row]").forEach((el) => {
      const id = el.dataset.row ?? "";
      if (id === s.id) {
        s.self = { top: el.offsetTop, height: el.offsetHeight };
        s.orig = rects.length;
        el.style.willChange = "transform";
        return;
      }
      rects.push({ id, top: el.offsetTop, height: el.offsetHeight, depth: Number(el.dataset.depth ?? 0) });
    });
    s.rects = rects;
    s.g = s.orig;
    s.dropDepth = s.depth;
  };

  const onGripDown = (e: ReactPointerEvent<HTMLButtonElement>, row: Row) => {
    if (session.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    session.current = {
      id: row.folder.id,
      depth: row.depth,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.pageY,
      lifted: false,
      reduced: reducedMotion(),
      rects: [],
      self: { top: 0, height: 0 },
      orig: 0,
      g: 0,
      dropDepth: row.depth,
      dy: 0,
      vel: 0,
      lastT: e.timeStamp,
      landing: false,
      stop: null,
    };
    setPickerId(null);
    setMenuId(null);
    setConfirmId(null);
  };

  const onGripMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = session.current;
    if (!s || s.pointerId !== e.pointerId || s.landing) return;
    const dy = e.pageY - s.startY;
    if (!s.lifted) {
      if (Math.abs(dy) < LIFT_SLOP && Math.abs(e.clientX - s.startX) < LIFT_SLOP) return;
      lift(s);
      if (!s.rects.length) return;
    }
    const now = e.timeStamp;
    const dt = (now - s.lastT) / 1000;
    if (dt > 0) s.vel = (dy - s.dy) / dt;
    s.dy = dy;
    s.lastT = now;
    const el = rowEls.current.get(s.id);
    if (el) el.style.transform = liftTransform(dy);

    const host = containerRef.current;
    if (!host) return;
    const y = e.pageY - (host.getBoundingClientRect().top + window.scrollY);
    let g = 0;
    for (const r of s.rects) if (y > r.top + r.height / 2) g++;
    g = Math.max(1, g);
    const prev = s.rects[g - 1];
    const next = s.rects[g];
    const maxD = prev.depth + 1;
    const minD = Math.max(1, next ? next.depth : 1);
    const wanted = s.depth + Math.round((e.clientX - s.startX) / indent);
    const d = Math.min(maxD, Math.max(minD, wanted));
    const h = s.self.height;
    if (g !== s.g) {
      s.rects.forEach((r, j) => {
        const target = g < s.orig && j >= g && j < s.orig ? h : g > s.orig && j >= s.orig && j < g ? -h : 0;
        setShift(r.id, target, s.reduced);
      });
    }
    if (g !== s.g || d !== s.dropDepth) {
      s.g = g;
      s.dropDepth = d;
      setDrop({ y: gapTop(s) + h / 2 - 1, depth: d });
    }

    if (e.clientY < 64) window.scrollBy(0, -10);
    else if (e.clientY > window.innerHeight - 64) window.scrollBy(0, 10);
  };

  const finishDrop = (s: Session) => {
    const t = treeRef.current;
    const r = t.root;
    const node = findNode(r, s.id);
    let next = r;
    let parentId: string | null = null;
    if (node && (s.g !== s.orig || s.dropDepth !== s.depth)) {
      const target = resolveDrop(s.rects, s.g, s.dropDepth);
      if (!findNode(node, target.parentId)) {
        next = insertNode(removeNode(r, s.id), target.parentId, target.index, node);
        parentId = target.parentId;
      }
    }
    clearTransforms(s);
    session.current = null;
    setDrag(null);
    setDrop(null);
    if (parentId) expand(parentId);
    focusNext.current = s.id;
    setFocusedId(s.id);
    if (next !== r) onChangeRef.current({ ...t, root: next });
  };

  const land = (s: Session) => {
    s.landing = true;
    const el = rowEls.current.get(s.id);
    const to = gapTop(s) - s.self.top;
    if (s.reduced || !el) return finishDrop(s);
    s.stop = runSpring({
      from: s.dy,
      to,
      velocity: s.vel,
      response: 0.3,
      onFrame: (v) => {
        el.style.transform = liftTransform(v);
      },
      onDone: () => finishDrop(s),
    });
  };

  const onGripUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = session.current;
    if (!s || s.pointerId !== e.pointerId || s.landing) return;
    if (!s.lifted) {
      session.current = null;
      return;
    }
    land(s);
  };

  const onGripCancel = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = session.current;
    if (!s || s.pointerId !== e.pointerId || s.landing) return;
    if (s.lifted) {
      clearTransforms(s);
      setDrag(null);
      setDrop(null);
    }
    session.current = null;
  };

  /* Render */

  const knownSteps = useMemo(() => new Set(steps.map((s) => s.id)), [steps]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[14px] text-[#5B6560]">
          {count} {count === 1 ? "folder" : "folders"}
          {limitHit && <span className="ml-2 text-[#8A2E2E]">{MAX_FOLDERS} is the limit</span>}
        </p>
        <button type="button" className={`${primaryBtn} inline-flex items-center gap-1.5`} onClick={() => addChild(focusedId && findNode(root, focusedId) ? focusedId : root.id)}>
          <Ico name="plus" size={14} />
          Add folder
        </button>
      </div>

      <div ref={containerRef} role="tree" className={`relative ${drag ? "select-none" : ""}`}>
        {rows.map((row, at) => {
          const f = row.folder;
          const id = f.id;
          const isRoot = id === root.id;
          const hasChildren = f.children.length > 0;
          const open = hasChildren && !collapsed.has(id);
          const lifted = drag?.id === id;
          const selected = focusedId === id;
          const editingName = editing?.id === id && editing.field === "name";
          const editingPurpose = editing?.id === id && editing.field === "purpose";
          const chips = f.steps ?? [];
          const options: StepOption[] = [...steps, ...chips.filter((x) => !knownSteps.has(x)).map((x) => ({ id: x }))];
          const on = new Set(chips);
          const subtree = countFolders(f);
          const confirming = confirmId === id;
          const hit = isRoot ? null : findParent(root, id);
          const canUp = !!hit && hit.index > 0;
          const canDown = !!hit && hit.index < hit.parent.children.length - 1;
          const canIndent = !!hit && hit.index > 0;
          const canOutdent = !!hit && hit.parent.id !== root.id;

          const editInput = (
            <input
              ref={inputRef}
              className={`${inputCls} max-w-md`}
              value={draft}
              aria-label={editingName ? "Folder name" : "Purpose"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === "Escape") {
                  cancelEdit.current = true;
                  setEditing(null);
                  focusNext.current = id;
                }
              }}
              onBlur={() => {
                if (cancelEdit.current) {
                  cancelEdit.current = false;
                  return;
                }
                commitEdit();
              }}
            />
          );

          const deleteControl = confirming ? (
            <button type="button" className={dangerBtn} onClick={() => deleteNow(id)}>
              {deleteLabel(subtree)}
            </button>
          ) : null;

          return (
            <div
              key={id}
              ref={(el) => {
                if (el) rowEls.current.set(id, el);
                else rowEls.current.delete(id);
              }}
              data-row={id}
              data-depth={row.depth}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={hasChildren ? open : undefined}
              aria-selected={selected}
              tabIndex={0}
              className={`group relative flex items-start rounded-lg pr-1 outline-none focus-visible:ring-1 focus-visible:ring-[#14201B]/40 ${
                lifted ? "z-20 bg-white shadow-[0_8px_24px_rgba(20,32,27,0.14)]" : selected ? "bg-[#14201B]/[0.03]" : ""
              }`}
              style={{ paddingLeft: row.depth * indent }}
              onFocus={() => setFocusedId(id)}
              onKeyDown={(e) => onRowKey(e, row, at)}
            >
              {Array.from({ length: row.depth }, (_, d) => (
                <span key={d} aria-hidden="true" className="absolute top-0 bottom-0 w-px bg-[#E2DFD5]" style={{ left: d * indent + GUIDE_X }} />
              ))}

              {hasChildren ? (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={open ? "Collapse" : "Expand"}
                  className={`${iconBtn} text-[#8A928C]`}
                  onClick={() => toggle(id)}
                >
                  <Triangle open={open} />
                </button>
              ) : (
                <span className="h-11 w-11 shrink-0" />
              )}

              {isRoot ? (
                <span className="h-11 w-11 shrink-0" />
              ) : (
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Move"
                  className={`flex h-11 w-11 shrink-0 cursor-grab touch-none items-center justify-center text-[#8A928C] active:cursor-grabbing md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 ${lifted ? "md:opacity-100" : ""}`}
                  onPointerDown={(e) => onGripDown(e, row)}
                  onPointerMove={onGripMove}
                  onPointerUp={onGripUp}
                  onPointerCancel={onGripCancel}
                >
                  <GripIcon />
                </button>
              )}

              <div className="relative min-w-0 flex-1">
                <div className="flex min-h-11 items-center gap-2">
                  <span className="text-[#5B6560]">
                    <FolderIcon />
                  </span>
                  {editingName ? (
                    editInput
                  ) : (
                    <button
                      type="button"
                      className="min-h-11 min-w-0 flex-1 truncate text-left text-[16px] leading-6 text-[#14201B]"
                      onClick={() => startEdit(id, "name", f.name)}
                    >
                      {f.name}
                    </button>
                  )}
                  {!editingName && !f.purpose && !editingPurpose && (
                    <button type="button" className={`${quietBtn} ${reveal}`} onClick={() => startEdit(id, "purpose", "")}>
                      Purpose
                    </button>
                  )}
                  {!editingName && options.length > 0 && (
                    <button
                      type="button"
                      data-pop
                      aria-expanded={pickerId === id}
                      className={`${quietBtn} ${chips.length ? "" : reveal}`}
                      onClick={() => setPickerId((p) => (p === id ? null : id))}
                    >
                      Steps
                    </button>
                  )}
                </div>

                {editingPurpose ? (
                  <div className="pb-2">{editInput}</div>
                ) : (
                  f.purpose && (
                    <button
                      type="button"
                      className="-mt-2 block min-h-8 w-full pb-1 text-left text-[13px] leading-5 text-[#5B6560]"
                      onClick={() => startEdit(id, "purpose", f.purpose ?? "")}
                    >
                      {f.purpose}
                    </button>
                  )
                )}

                {chips.length > 0 && (
                  <div className="flex flex-wrap gap-1 pb-2">
                    {chips.map((s) => (
                      <span key={s} className="rounded-full border border-[#E2DFD5] bg-white px-2 py-0.5 text-[12px] leading-5 text-[#3D4A44]">
                        {s}
                      </span>
                    ))}
                  </div>
                )}

                {pickerId === id && (
                  <div data-pop role="group" aria-label="Steps" className={`${popCls} w-72 max-w-[calc(100vw-2rem)]`}>
                    {options.map((o) => {
                      const checked = on.has(o.id);
                      return (
                        <button
                          key={o.id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={checked}
                          className={`flex min-h-11 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-[#14201B]/[0.04] ${press}`}
                          onClick={() => toggleStep(id, o.id)}
                        >
                          <span
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                              checked ? "border-[#14201B] bg-[#14201B] text-white" : "border-[#E2DFD5]"
                            }`}
                          >
                            {checked && <Ico name="check" size={12} />}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-[14px] text-[#14201B]">{o.name ?? o.id}</span>
                            {o.name && <span className="block truncate text-[12px] text-[#8A928C]">{o.id}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className={`hidden shrink-0 items-center md:flex ${reveal}`}>
                <button type="button" tabIndex={-1} aria-label="Add subfolder" className={iconBtn} onClick={() => addChild(id)}>
                  <Ico name="plus" />
                </button>
                {!isRoot && (
                  <>
                    <button type="button" tabIndex={-1} aria-label="Move up" className={iconBtn} disabled={!canUp} onClick={() => moveSibling(id, -1)}>
                      <Ico name="chevron-up" />
                    </button>
                    <button type="button" tabIndex={-1} aria-label="Move down" className={iconBtn} disabled={!canDown} onClick={() => moveSibling(id, 1)}>
                      <Ico name="chevron-down" />
                    </button>
                    <button type="button" tabIndex={-1} aria-label="Outdent" className={iconBtn} disabled={!canOutdent} onClick={() => outdentRow(id)}>
                      <Inline name="outdent" />
                    </button>
                    <button type="button" tabIndex={-1} aria-label="Indent" className={iconBtn} disabled={!canIndent} onClick={() => indentRow(id)}>
                      <Inline name="indent" />
                    </button>
                    {deleteControl ?? (
                      <button type="button" tabIndex={-1} aria-label="Delete" className={`${iconBtn} hover:text-[#8A2E2E]`} onClick={() => requestDelete(id, false)}>
                        <Inline name="trash" />
                      </button>
                    )}
                  </>
                )}
              </div>

              <div className="relative shrink-0 md:hidden">
                <button
                  type="button"
                  data-pop
                  aria-label="More"
                  aria-expanded={menuId === id}
                  className={iconBtn}
                  onClick={() => setMenuId((m) => (m === id ? null : id))}
                >
                  <Ico name="more" />
                </button>
                {menuId === id && (
                  <div data-pop role="menu" className={`${popCls} w-56`}>
                    <button type="button" role="menuitem" className={menuItem} onClick={() => addChild(id)}>
                      <Ico name="plus" />
                      Add subfolder
                    </button>
                    {!isRoot && (
                      <>
                        <button type="button" role="menuitem" className={menuItem} disabled={!canUp} onClick={() => moveSibling(id, -1)}>
                          <Ico name="chevron-up" />
                          Move up
                        </button>
                        <button type="button" role="menuitem" className={menuItem} disabled={!canDown} onClick={() => moveSibling(id, 1)}>
                          <Ico name="chevron-down" />
                          Move down
                        </button>
                        <button type="button" role="menuitem" className={menuItem} disabled={!canOutdent} onClick={() => outdentRow(id)}>
                          <Inline name="outdent" />
                          Outdent
                        </button>
                        <button type="button" role="menuitem" className={menuItem} disabled={!canIndent} onClick={() => indentRow(id)}>
                          <Inline name="indent" />
                          Indent
                        </button>
                        {confirming ? (
                          <button type="button" role="menuitem" className={`${menuItem} font-medium text-[#8A2E2E]`} onClick={() => deleteNow(id)}>
                            <Inline name="trash" />
                            {deleteLabel(subtree)}
                          </button>
                        ) : (
                          <button type="button" role="menuitem" className={`${menuItem} text-[#8A2E2E]`} onClick={() => requestDelete(id, false)}>
                            <Inline name="trash" />
                            Delete
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {drop && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute right-0 z-30 h-0.5 rounded-full bg-[#14201B]"
            style={{ top: drop.y, left: drop.depth * indent + 8 }}
          />
        )}
      </div>
    </div>
  );
}
