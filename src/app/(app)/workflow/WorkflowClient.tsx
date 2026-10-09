"use client";

/**
 * The Workflow screen: two boards, Maps and Folders, each a picker of
 * documents and one open document under a small toolbar, handed to its
 * designer (MapDesigner, FolderDesigner) whole. Both boards stay mounted so
 * switching tabs costs no read and keeps each board's undo stack; the
 * Folders tab reads the open map's steps straight from the Maps board.
 *
 * Edits land optimistically and are written 600ms after the last keystroke,
 * one timer per document, flushed when the tab hides or the screen unmounts,
 * so a designer can re-render on every change without a request per change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Ico, PageHead, SkeletonBar, SuccessNote, ghostBtn, primaryBtn } from "../../../lib/core/ui";
import { mapToMarkdown, treeToText } from "../../../lib/features/workflow/export";
import { SEED_MAP, SEED_TREE } from "../../../lib/features/workflow/seed";
import { emptyMap, emptyTree, type Board, type FolderTree, type Item, type WorkflowMap } from "../../../lib/features/workflow/types";
import { useDocs, type Docs } from "../../../lib/features/workflow/use-docs";
import { FolderDesigner } from "./FolderDesigner";
import { MapDesigner } from "./MapDesigner";

const TABS: { id: Board; label: string }[] = [
  { id: "maps", label: "Maps" },
  { id: "folders", label: "Folders" },
];
const TAB_KEY = "nb_workflow_tab";
const OPEN_KEY = (b: Board) => `nb_workflow_open_${b}`;
const SAVE_MS = 600;
const NOTE_MS = 1100;
const ARM_MS = 3000;

const readLocal = (k: string): string | null => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const writeLocal = (k: string, v: string) => {
  try { localStorage.setItem(k, v); } catch { /* private mode: the choice lasts the session */ }
};

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/* ---- debounced, per-document writes over useDocs ---------------------- */

type Pending<T> = { timer: ReturnType<typeof setTimeout>; next: T };

function useDraftSave<T extends object>(docs: Docs<T>) {
  const [drafts, setDrafts] = useState<Record<string, T>>({});
  const pending = useRef(new Map<string, Pending<T>>());
  const setDoc = useRef(docs.set);
  useEffect(() => {
    setDoc.current = docs.set;
  }, [docs.set]);

  const flush = useCallback(async (only?: string) => {
    const ids = only ? [only] : [...pending.current.keys()];
    await Promise.all(
      ids.map(async (id) => {
        const p = pending.current.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.current.delete(id);
        const ok = await setDoc.current(id, p.next);
        // A failed write keeps the draft on screen so nothing typed is lost;
        // the next edit sends the whole document again.
        if (ok) setDrafts((d) => (d[id] === p.next ? without(d, id) : d));
      }),
    );
  }, []);

  const save = useCallback(
    (id: string, next: T) => {
      setDrafts((d) => ({ ...d, [id]: next }));
      const prev = pending.current.get(id);
      if (prev) clearTimeout(prev.timer);
      pending.current.set(id, { next, timer: setTimeout(() => void flush(id), SAVE_MS) });
    },
    [flush],
  );

  /** Forget a document's unsent edits (it is being deleted). */
  const drop = useCallback((id: string) => {
    const p = pending.current.get(id);
    if (p) clearTimeout(p.timer);
    pending.current.delete(id);
    setDrafts((d) => (id in d ? without(d, id) : d));
  }, []);

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "hidden") void flush(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void flush();
    };
  }, [flush]);

  const dataOf = useCallback(
    (id: string | null): T | null => (id ? (drafts[id] ?? docs.items.find((x) => x.id === id)?.data ?? null) : null),
    [drafts, docs.items],
  );

  return { save, flush, drop, dataOf };
}

function without<T>(d: Record<string, T>, id: string): Record<string, T> {
  const next = { ...d };
  delete next[id];
  return next;
}

/** Which document is open on a board: the one chosen (or remembered) when
 *  the board still holds it, else the first. Derived, so a delete or a
 *  fresh load never leaves a stale id open. */
function useOpen(items: Item<unknown>[], board: Board) {
  const [wanted, setWanted] = useState<string | null>(null);
  useEffect(() => {
    // localStorage exists only in the browser; reading it during render
    // would mismatch the static HTML.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWanted(readLocal(OPEN_KEY(board)));
  }, [board]);
  const openId = (wanted && items.some((x) => x.id === wanted) ? wanted : items[0]?.id) ?? null;
  const open = useCallback(
    (id: string) => {
      setWanted(id);
      writeLocal(OPEN_KEY(board), id);
    },
    [board],
  );
  return { openId, open };
}

/* ---- the screen ------------------------------------------------------- */

export function WorkflowClient() {
  const [tab, setTab] = useState<Board>("maps");
  useEffect(() => {
    const t = readLocal(TAB_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (t === "maps" || t === "folders") setTab(t);
  }, []);
  const pickTab = (t: Board) => {
    setTab(t);
    writeLocal(TAB_KEY, t);
  };

  const maps = useDocs<WorkflowMap>("maps");
  const trees = useDocs<FolderTree>("folders");
  const mapDraft = useDraftSave(maps);
  const treeDraft = useDraftSave(trees);
  const mapOpen = useOpen(maps.items, "maps");
  const treeOpen = useOpen(trees.items, "folders");

  // One Cmd+Z for the board on screen. Both useDocs hooks listen on
  // document; this capture listener on window runs first and stops them,
  // then flushes the board's unsent edit so undo reverts the latest one.
  const active = tab === "maps" ? maps : trees;
  const activeFlush = tab === "maps" ? mapDraft.flush : treeDraft.flush;
  const undoRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    undoRef.current = async () => {
      await activeFlush();
      await active.undo();
    };
  }, [activeFlush, active]);
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      !!(t instanceof Element && t.closest("input,textarea,select,[contenteditable]"));
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && !typing(e.target)) {
        e.preventDefault();
        e.stopPropagation();
        void undoRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const openMap = mapDraft.dataOf(mapOpen.openId);
  const steps = useMemo(() => (openMap ? openMap.steps.map((s) => ({ id: s.id, name: s.name })) : []), [openMap]);

  return (
    <div className="flex w-full flex-col">
      <PageHead title="Workflow" aside={<Segmented value={tab} onChange={pickTab} />} />

      {tab === "maps" ? (
        <BoardView<WorkflowMap>
          key="maps"
          docs={maps}
          draft={mapDraft}
          openId={mapOpen.openId}
          onOpen={mapOpen.open}
          noun="map"
          seed={SEED_MAP}
          blank={() => emptyMap("New map")}
          copyLabel="Copy as table"
          toText={mapToMarkdown}
          render={(doc, onChange) => <MapDesigner map={doc} onChange={onChange} />}
        />
      ) : (
        <BoardView<FolderTree>
          key="folders"
          docs={trees}
          draft={treeDraft}
          openId={treeOpen.openId}
          onOpen={treeOpen.open}
          noun="tree"
          seed={SEED_TREE}
          blank={() => emptyTree("Drive folders")}
          copyLabel="Copy tree"
          toText={treeToText}
          render={(doc, onChange) => <FolderDesigner tree={doc} steps={steps} onChange={onChange} />}
        />
      )}
    </div>
  );
}

/* ---- segmented control ------------------------------------------------ */

function Segmented({ value, onChange }: { value: Board; onChange: (t: Board) => void }) {
  const idx = Math.max(0, TABS.findIndex((t) => t.id === value));
  return (
    <div role="tablist" aria-label="Board" className="relative grid w-[220px] shrink-0 self-center grid-cols-2 rounded-xl border border-[#E2DFD5] bg-[#FAF9F5] p-0.5">
      <span
        aria-hidden="true"
        className="absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-2px)] rounded-[10px] bg-[#14201B] transition-transform duration-200 ease-out motion-reduce:transition-none"
        style={{ transform: `translateX(${idx * 100}%)` }}
      />
      {TABS.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={on}
            onPointerDown={() => onChange(t.id)}
            onClick={() => onChange(t.id)}
            className={`relative z-10 min-h-11 rounded-[10px] px-3 text-[14px] font-medium transition-colors duration-200 motion-reduce:transition-none ${
              on ? "text-white" : "text-[#3D4A44]"
            }`}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---- one board: picker, toolbar, designer ----------------------------- */

type Titled = { title: string };

type BoardProps<T extends Titled> = {
  docs: Docs<T>;
  draft: ReturnType<typeof useDraftSave<T>>;
  openId: string | null;
  onOpen: (id: string) => void;
  noun: "map" | "tree";
  seed: T;
  blank: () => T;
  copyLabel: string;
  toText: (doc: T) => string;
  render: (doc: T, onChange: (next: T) => void) => React.ReactNode;
};

function BoardView<T extends Titled>({ docs, draft, openId, onOpen, noun, seed, blank, copyLabel, toText, render }: BoardProps<T>) {
  const [note, setNote] = useState<string | null>(null);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (noteTimer.current) clearTimeout(noteTimer.current);
    if (armTimer.current) clearTimeout(armTimer.current);
  }, []);

  const doc = draft.dataOf(openId);
  const hasSeed = docs.items.some((x) => sameTitle(x.data.title, seed.title));

  const addAndOpen = async (data: T) => {
    const id = await docs.add(data);
    if (id) onOpen(id);
  };

  const showNote = (text: string) => {
    setNote(text);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(null), NOTE_MS);
  };

  const copy = async () => {
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(toText(doc));
      setLocalErr(null);
      showNote("Copied");
    } catch {
      setLocalErr("Could not copy.");
    }
  };

  const del = async () => {
    if (!openId) return;
    if (!armed) {
      setArmed(true);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmed(false), ARM_MS);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmed(false);
    draft.drop(openId);
    await docs.remove(openId);
  };

  const undo = async () => {
    await draft.flush();
    await docs.undo();
  };

  const onChange = (next: T) => {
    if (!openId) return;
    setLocalErr(null);
    draft.save(openId, next);
  };

  const error = localErr ?? docs.error;

  if (docs.loading) {
    return (
      <div className="flex w-full flex-col gap-4">
        <SkeletonBar className="h-11 w-full max-w-[520px]" />
        <SkeletonBar className="h-11 w-72" />
        <SkeletonBar className="h-72 w-full" />
      </div>
    );
  }

  if (!docs.items.length) {
    return (
      <Card className="max-w-[520px]">
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void addAndOpen(seed)} className={primaryBtn}>
            Start from the marketing plan
          </button>
          <button type="button" onClick={() => void addAndOpen(blank())} className={`${ghostBtn} flex items-center gap-1.5`}>
            <Ico name="plus" size={14} />
            New {noun}
          </button>
        </div>
        {error && <p className="mt-3 text-[13px] text-[#8A2E2E]">{error}</p>}
      </Card>
    );
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {/* Picker: one pill per document, scrolls sideways on a phone. */}
      <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none] md:-mx-0 md:px-0 [&::-webkit-scrollbar]:hidden">
        {docs.items.map((x) => {
          const on = x.id === openId;
          const title = (draft.dataOf(x.id)?.title ?? x.data.title).trim();
          return (
            <button
              key={x.id}
              type="button"
              aria-pressed={on}
              onClick={() => onOpen(x.id)}
              className={`min-h-11 shrink-0 rounded-full border px-4 text-[14px] whitespace-nowrap transition-[transform,background-color,color] active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 ${
                on ? "border-[#14201B] bg-[#14201B] font-medium text-white" : "border-[#E2DFD5] bg-white text-[#3D4A44]"
              }`}
            >
              {title || `Untitled ${noun}`}
            </button>
          );
        })}
        <button type="button" onClick={() => void addAndOpen(blank())} className={`${ghostBtn} flex shrink-0 items-center gap-1.5 whitespace-nowrap`}>
          <Ico name="plus" size={14} />
          New {noun}
        </button>
        {!hasSeed && (
          <button type="button" onClick={() => void addAndOpen(seed)} className={`${ghostBtn} shrink-0 whitespace-nowrap`}>
            Add the plan&rsquo;s {noun}
          </button>
        )}
      </div>

      {doc && openId && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <TitleField value={doc.title} onCommit={(title) => onChange({ ...doc, title })} />
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void copy()} className={ghostBtn}>
                {copyLabel}
              </button>
              <button
                type="button"
                onClick={() => void del()}
                className={`${ghostBtn} ${armed ? "font-medium text-[#8A2E2E]" : ""}`}
              >
                {armed ? "Confirm delete" : `Delete ${noun}`}
              </button>
              {docs.canUndo && (
                <button type="button" onClick={() => void undo()} className={ghostBtn}>
                  Undo
                </button>
              )}
              {note && <SuccessNote title={note} />}
            </div>
          </div>
          {error && <p className="-mt-2 text-[13px] text-[#8A2E2E]">{error}</p>}

          {render(doc, onChange)}
        </>
      )}
    </div>
  );
}

/* ---- inline title ----------------------------------------------------- */

function TitleField({ value, onCommit }: { value: string; onCommit: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  const begin = () => {
    setText(value);
    setEditing(true);
  };
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const t = text.trim();
    if (t && t !== value) onCommit(t);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={begin}
        title="Rename"
        className="min-h-11 max-w-full truncate rounded-md px-2 text-left text-[18px] font-semibold tracking-tight text-[#14201B] transition-colors hover:bg-[#ECEAE1] md:mr-2"
      >
        {value.trim() || "Untitled"}
      </button>
    );
  }
  return (
    <input
      ref={ref}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      aria-label="Title"
      className="min-h-11 w-full max-w-[420px] rounded-md border border-[#E2DFD5] bg-[#FAF9F5] px-2 text-[16px] font-semibold tracking-tight text-[#14201B] focus:border-[#14201B]/60 focus:outline-none md:mr-2"
    />
  );
}
