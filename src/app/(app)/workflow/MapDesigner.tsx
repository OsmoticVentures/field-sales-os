"use client";

/**
 * The workflow map, drawn as phases left to right and steps top to bottom,
 * with the step editor below the flow. Fully controlled: every committed
 * edit calls onChange with a new map and the parent saves it.
 *
 * The view stays put, as on the Marketing roadmap: the editor opens under
 * the flow (under the card itself on a phone) and never scrolls the page,
 * Delete removes the selection, Escape closes. A drag lifts the card on
 * the pointer (a short hold on touch, so a swipe still scrolls), siblings
 * part with the shared spring, and the drop commits order and phase in
 * one onChange; the card then springs from where it was let go into its
 * new slot. A step whose phase no longer exists is kept in a trailing
 * Unplaced column rather than dropped.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Ico, ghostBtn, inputCls, labelCls } from "@/lib/core/ui";
import { runFade, runSpring } from "@/lib/core/spring";
import { ACTORS, FILTERS, MAX_STEPS, TYPOLOGIES, slug } from "@/lib/features/workflow/types";
import type { Filter, Phase, Step, WorkflowMap } from "@/lib/features/workflow/types";

const FILTER_KEYS = Object.keys(FILTERS) as Filter[];
const UNPLACED = "__unplaced";
const CARD_GAP = 22; // px between stacked cards, room for the connector
const HOLD_MS = 220; // touch hold before a card lifts
const LIFT_PX = 6; // pointer travel before a mouse drag lifts

/* ---------- media ---------- */

const mqWide = () => window.matchMedia("(min-width: 768px)").matches;
const subWide = (notify: () => void) => {
  const mq = window.matchMedia("(min-width: 768px)");
  mq.addEventListener("change", notify);
  return () => mq.removeEventListener("change", notify);
};
const mqReduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const subReduced = (notify: () => void) => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", notify);
  return () => mq.removeEventListener("change", notify);
};

/* ---------- map helpers (pure) ---------- */

const uniqueId = (base: string, taken: Set<string>): string => {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}_${n}`;
    if (!taken.has(id)) return id;
  }
};

const stepIds = (map: WorkflowMap, except?: string) =>
  new Set(map.steps.filter((s) => s.id !== except).map((s) => s.id));

/** Where a new step for this phase goes in the global order: after the last
 *  step of this phase or any earlier phase, at the start when there is none. */
function insertIndexForPhase(phases: Phase[], steps: Step[], phaseId: string): number {
  const order = phases.findIndex((p) => p.id === phaseId);
  if (order < 0) return steps.length;
  const earlier = new Set(phases.slice(0, order + 1).map((p) => p.id));
  let at = 0;
  steps.forEach((s, i) => {
    if (earlier.has(s.phase)) at = i + 1;
  });
  return at;
}

/** Moves a step into `phaseId` at column position `k` (Infinity for last). */
function placeStep(map: WorkflowMap, id: string, phaseId: string, k: number): WorkflowMap {
  const step = map.steps.find((s) => s.id === id);
  if (!step) return map;
  const rest = map.steps.filter((s) => s.id !== id);
  const moved = step.phase === phaseId ? step : { ...step, phase: phaseId };
  const col = rest.filter((s) => s.phase === phaseId);
  let at: number;
  if (k < col.length) at = rest.indexOf(col[k]);
  else if (col.length) at = rest.indexOf(col[col.length - 1]) + 1;
  else at = insertIndexForPhase(map.phases, rest, phaseId);
  return { ...map, steps: [...rest.slice(0, at), moved, ...rest.slice(at)] };
}

/** One slot earlier or later in the walk: within the phase first, then over
 *  the edge into the neighbouring phase as its last or first step. */
function walkStep(map: WorkflowMap, id: string, dir: -1 | 1): WorkflowMap {
  const step = map.steps.find((s) => s.id === id);
  if (!step) return map;
  const col = map.steps.filter((s) => s.phase === step.phase);
  const i = col.indexOf(step);
  const p = map.phases.findIndex((ph) => ph.id === step.phase);
  if (dir < 0) {
    if (i > 0) return placeStep(map, id, step.phase, i - 1);
    if (p > 0) return placeStep(map, id, map.phases[p - 1].id, Infinity);
    return map;
  }
  if (i < col.length - 1) return placeStep(map, id, step.phase, i + 1);
  if (p >= 0 && p < map.phases.length - 1) return placeStep(map, id, map.phases[p + 1].id, 0);
  return map;
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
};

/* ---------- small pieces ---------- */

const iconBtn =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl text-[#5B6560] transition-[transform,background-color] [@media(hover:hover)]:hover:bg-[#14201B]/[0.05] active:scale-[0.97] active:bg-[#14201B]/[0.08] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:opacity-40 disabled:active:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#14201B]/50";

const smallBtn =
  "inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-[14px] text-[#3D4A44] transition-[transform,background-color] [@media(hover:hover)]:hover:bg-[#14201B]/[0.05] active:scale-[0.97] active:bg-[#14201B]/[0.08] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:opacity-40 disabled:active:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#14201B]/50";

/** Icons the shared set does not have, same stroke style, drawn here. */
function LocalIco({ name, size = 16 }: { name: "copy" | "trash" | "arrow-up" | "arrow-down"; size?: number }) {
  const d: Record<string, ReactNode> = {
    copy: (
      <>
        <rect x="5.6" y="5.6" width="8" height="8" rx="1.4" />
        <path d="M10.4 5.6V3.6a1.2 1.2 0 0 0-1.2-1.2H3.6a1.2 1.2 0 0 0-1.2 1.2v5.6a1.2 1.2 0 0 0 1.2 1.2h2" />
      </>
    ),
    trash: (
      <>
        <path d="M3 4.6h10M6.4 4.6V3.2h3.2v1.4M4.2 4.6l.6 8.2h6.4l.6-8.2" />
        <path d="M6.8 7v3.6M9.2 7v3.6" />
      </>
    ),
    "arrow-up": <path d="M8 13.2V2.8M3.6 7.2 8 2.8l4.4 4.4" />,
    "arrow-down": <path d="M8 2.8v10.4M3.6 8.8 8 13.2l4.4-4.4" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {d[name]}
    </svg>
  );
}

function FilterChip({ filter }: { filter: Filter }) {
  const base = "inline-flex h-[22px] items-center rounded-full px-2 text-[12px] font-medium leading-none";
  if (filter === "F3") return <span className={`${base} bg-[#14201B] text-[#FAF9F5]`}>{FILTERS.F3.short}</span>;
  if (filter === "F1") return <span className={`${base} border border-[#E2DFD5] text-[#5B6560]`}>{FILTERS.F1.short}</span>;
  return <span className={`${base} bg-[#E3EEE7] text-[#2C6A46]`}>{FILTERS[filter].short}</span>;
}

/** A two-row textarea that grows with its text. */
function GrowingTextarea({
  value,
  onChange,
  onBlur,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  id?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      id={id}
      rows={2}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className={`${inputCls} resize-none overflow-hidden leading-[1.45]`}
    />
  );
}

/* ---------- the editor ---------- */

type EditorProps = {
  step: Step;
  map: WorkflowMap;
  onPatch: (id: string, patch: Partial<Step>) => void;
  onPhase: (id: string, phaseId: string) => void;
  onDuplicate: (id: string) => void;
  onWalk: (id: string, dir: -1 | 1) => void;
  onRemove: (id: string) => void;
};

function StepEditor({ step, map, onPatch, onPhase, onDuplicate, onWalk, onRemove }: EditorProps) {
  const uid = useId();
  const [draft, setDraft] = useState(() => ({
    id: step.id,
    name: step.name,
    actorNow: step.actorNow,
    actorTarget: step.actorTarget,
    typology: step.typology,
    input: step.input,
    output: step.output,
    tool: step.tool ?? "",
    note: step.note ?? "",
  }));
  const [idTouched, setIdTouched] = useState(() => step.id !== slug(step.name));
  const [idError, setIdError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const pending = useRef<Partial<Step>>({});
  const timer = useRef<number | null>(null);
  const live = useRef({ step, map, onPatch });
  useEffect(() => {
    live.current = { step, map, onPatch };
  });

  const flush = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) live.current.onPatch(live.current.step.id, patch);
  }, []);

  useEffect(() => () => flush(), [flush]);

  const queue = useCallback(
    (patch: Partial<Step>) => {
      pending.current = { ...pending.current, ...patch };
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 250);
    },
    [flush],
  );

  const edit = (patch: Partial<typeof draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    const out: Partial<Step> = { ...patch };
    if ("name" in patch && !idTouched) {
      const id = uniqueId(slug(patch.name ?? ""), stepIds(live.current.map, live.current.step.id));
      setDraft((d) => ({ ...d, id }));
      setIdError(null);
      out.id = id;
    }
    queue(out);
  };

  const editId = (raw: string) => {
    setIdTouched(true);
    setDraft((d) => ({ ...d, id: raw }));
    if (!raw.trim()) {
      setIdError("A step needs an id.");
      delete pending.current.id;
      return;
    }
    const other = live.current.map.steps.find((s) => s.id === raw && s.id !== live.current.step.id);
    if (other) {
      setIdError(`Already used by ${other.name || other.id}.`);
      delete pending.current.id;
      return;
    }
    setIdError(null);
    queue({ id: raw });
  };

  const text = (key: keyof typeof draft, label: string, list?: string) => (
    <div className="min-w-0">
      <label htmlFor={`${uid}-${key}`} className={labelCls}>
        {label}
      </label>
      <input
        id={`${uid}-${key}`}
        className={inputCls}
        value={draft[key]}
        list={list}
        autoComplete="off"
        onChange={(e) => edit({ [key]: e.target.value })}
        onBlur={flush}
      />
    </div>
  );

  const remove = () => {
    if (!armed) {
      setArmed(true);
      window.setTimeout(() => setArmed(false), 3000);
      return;
    }
    onRemove(step.id);
  };

  return (
    <div className="rounded-xl border-[1.5px] border-[#14201B] bg-white p-4 md:p-5">
      <datalist id={`${uid}-actors`}>
        {ACTORS.map((a) => (
          <option key={a} value={a} />
        ))}
      </datalist>
      <datalist id={`${uid}-typologies`}>
        {TYPOLOGIES.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>

      <div className="grid gap-3.5 md:grid-cols-2">
        {text("name", "Name")}
        <div className="min-w-0">
          <label htmlFor={`${uid}-id`} className={labelCls}>
            Step id
          </label>
          <input
            id={`${uid}-id`}
            className={`${inputCls} ${idError ? "border-[#8A2E2E] focus:border-[#8A2E2E]" : ""}`}
            value={draft.id}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => editId(e.target.value)}
            onBlur={flush}
          />
          {idError && <div className="mt-1 text-[13px] text-[#8A2E2E]">{idError}</div>}
        </div>
        <div className="min-w-0">
          <label htmlFor={`${uid}-phase`} className={labelCls}>
            Phase
          </label>
          <select
            id={`${uid}-phase`}
            className={inputCls}
            value={step.phase}
            onChange={(e) => onPhase(step.id, e.target.value)}
          >
            {!map.phases.some((p) => p.id === step.phase) && <option value={step.phase}>{step.phase}</option>}
            {map.phases.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        {text("typology", "Typology", `${uid}-typologies`)}
        {text("actorNow", "Actor now", `${uid}-actors`)}
        {text("actorTarget", "Actor target", `${uid}-actors`)}
        <div className="min-w-0">
          <label htmlFor={`${uid}-input`} className={labelCls}>
            Input payload
          </label>
          <GrowingTextarea id={`${uid}-input`} value={draft.input} onChange={(v) => edit({ input: v })} onBlur={flush} />
        </div>
        <div className="min-w-0">
          <label htmlFor={`${uid}-output`} className={labelCls}>
            Output payload
          </label>
          <GrowingTextarea id={`${uid}-output`} value={draft.output} onChange={(v) => edit({ output: v })} onBlur={flush} />
        </div>
        <div className="min-w-0 md:col-span-2">
          <div className={labelCls}>Filter</div>
          <div role="radiogroup" aria-label="Filter" className="grid grid-cols-4 overflow-hidden rounded-xl border border-[#E2DFD5] bg-[#FAF9F5]">
            {FILTER_KEYS.map((f) => {
              const on = step.filter === f;
              return (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  title={FILTERS[f].label}
                  onClick={() => onPatch(step.id, { filter: f })}
                  className={`min-h-11 text-[14px] transition-[transform,background-color,color] active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[#14201B]/60 ${
                    on ? "bg-[#14201B] font-medium text-[#FAF9F5]" : "text-[#3D4A44] [@media(hover:hover)]:hover:bg-[#14201B]/[0.05]"
                  }`}
                >
                  {FILTERS[f].short}
                </button>
              );
            })}
          </div>
          <div className="mt-1.5 text-[13px] text-[#5B6560]">{FILTERS[step.filter].label}</div>
        </div>
        {text("tool", "Tool")}
        {text("note", "Note")}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#E2DFD5] pt-4">
        <button type="button" className={smallBtn} onClick={() => onDuplicate(step.id)}>
          <LocalIco name="copy" />
          Duplicate
        </button>
        <button type="button" className={smallBtn} onClick={() => onWalk(step.id, -1)}>
          <LocalIco name="arrow-up" />
          Move earlier
        </button>
        <button type="button" className={smallBtn} onClick={() => onWalk(step.id, 1)}>
          <LocalIco name="arrow-down" />
          Move later
        </button>
        <button type="button" className={`${smallBtn} ml-auto text-[#8A2E2E]`} onClick={remove}>
          <LocalIco name="trash" />
          {armed ? "Tap again to delete" : "Delete"}
        </button>
      </div>
    </div>
  );
}

/* ---------- drag state ---------- */

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type DragCol = { phaseId: string; box: Box; cards: { id: string; box: Box; el: HTMLDivElement }[] };
type Drag = {
  id: string;
  pointerId: number;
  el: HTMLDivElement;
  isTouch: boolean;
  lifted: boolean;
  hold: number | null;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  cols: DragCol[];
  afterInSource: Set<string>;
  srcPhase: string;
  srcK: number;
  target: { phaseId: string; k: number };
  H: number;
  hist: { t: number; x: number; y: number }[];
};
type Sib = { pos: number; vel: number; target: number; stop: (() => void) | null };

const boxOf = (el: Element, origin: DOMRect): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top, width: r.width, height: r.height };
};
const distToBox = (x: number, y: number, b: Box) => {
  const dx = x < b.left ? b.left - x : x > b.right ? x - b.right : 0;
  const dy = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0;
  return Math.hypot(dx, dy);
};

/* ---------- the designer ---------- */

export function MapDesigner({ map, onChange }: { map: WorkflowMap; onChange: (next: WorkflowMap) => void }) {
  const wide = useSyncExternalStore(subWide, mqWide, () => false);
  const reduced = useSyncExternalStore(subReduced, mqReduced, () => false);

  const [selected, setSelected] = useState<string | null>(null);
  const [session, setSession] = useState(0); // remounts the editor on a fresh selection
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ phaseId: string; where: "header" | "footer"; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [paths, setPaths] = useState<string[]>([]);

  const mapRef = useRef(map);
  const wideRef = useRef(wide);
  const reducedRef = useRef(reduced);
  const selectedRef = useRef(selected);
  useEffect(() => {
    mapRef.current = map;
    wideRef.current = wide;
    reducedRef.current = reduced;
    selectedRef.current = selected;
  });

  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const listRefs = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<Drag | null>(null);
  const sibs = useRef(new Map<string, Sib>());
  const flip = useRef<{ id: string; cx: number; cy: number; vx: number; vy: number; stop: (() => void)[] } | null>(null);
  const flipFallback = useRef<number | null>(null);
  const focusAfter = useRef<string | null>(null);

  const commit = useCallback(
    (next: WorkflowMap) => {
      mapRef.current = next;
      onChange(next);
    },
    [onChange],
  );

  const select = (id: string | null) => {
    setSelected(id);
    if (id) setSession((n) => n + 1);
  };

  /* columns: phases in order, plus Unplaced when a step's phase is gone */
  const phaseIds = useMemo(() => new Set(map.phases.map((p) => p.id)), [map.phases]);
  const unplaced = useMemo(() => map.steps.filter((s) => !phaseIds.has(s.phase)), [map.steps, phaseIds]);
  const columns = useMemo<{ phase: Phase; steps: Step[]; real: boolean }[]>(() => {
    const cols = map.phases.map((phase) => ({ phase, steps: map.steps.filter((s) => s.phase === phase.id), real: true }));
    if (unplaced.length) cols.push({ phase: { id: UNPLACED, name: "Unplaced" }, steps: unplaced, real: false });
    return cols;
  }, [map.phases, map.steps, unplaced]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { F1: 0, F2: 0, F3: 0, AUTO: 0 };
    map.steps.forEach((s) => {
      c[s.filter] = (c[s.filter] ?? 0) + 1;
    });
    return c;
  }, [map.steps]);

  const selectedStep = selected ? map.steps.find((s) => s.id === selected) ?? null : null;

  /* ----- edits ----- */

  const patchStep = useCallback(
    (id: string, patch: Partial<Step>) => {
      const m = mapRef.current;
      if (!m.steps.some((s) => s.id === id)) return;
      commit({ ...m, steps: m.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
      if (patch.id && patch.id !== id) setSelected(patch.id);
    },
    [commit],
  );

  const setPhase = useCallback(
    (id: string, phaseId: string) => commit(placeStep(mapRef.current, id, phaseId, Infinity)),
    [commit],
  );

  const walk = useCallback(
    (id: string, dir: -1 | 1) => {
      const next = walkStep(mapRef.current, id, dir);
      if (next !== mapRef.current) {
        focusAfter.current = id;
        commit(next);
      }
    },
    [commit],
  );

  const removeStep = useCallback(
    (id: string) => {
      const m = mapRef.current;
      commit({ ...m, steps: m.steps.filter((s) => s.id !== id) });
      setSelected((cur) => (cur === id ? null : cur));
    },
    [commit],
  );

  const duplicateStep = useCallback(
    (id: string) => {
      const m = mapRef.current;
      const i = m.steps.findIndex((s) => s.id === id);
      if (i < 0) return;
      if (m.steps.length >= MAX_STEPS) {
        setNotice({ phaseId: m.steps[i].phase, where: "footer", text: `The map holds ${MAX_STEPS} steps.` });
        return;
      }
      const copy: Step = { ...m.steps[i], id: uniqueId(m.steps[i].id, stepIds(m)) };
      commit({ ...m, steps: [...m.steps.slice(0, i + 1), copy, ...m.steps.slice(i + 1)] });
      setNotice(null);
      select(copy.id);
    },
    [commit],
  );

  const addStep = (phaseId: string) => {
    const m = mapRef.current;
    if (m.steps.length >= MAX_STEPS) {
      setNotice({ phaseId, where: "footer", text: `The map holds ${MAX_STEPS} steps.` });
      return;
    }
    const step: Step = {
      id: uniqueId(slug("New step"), stepIds(m)),
      name: "New step",
      phase: phaseId,
      actorNow: "Human",
      actorTarget: "Agent",
      typology: "",
      input: "",
      output: "",
      filter: "AUTO",
    };
    const at = insertIndexForPhase(m.phases, m.steps, phaseId);
    commit({ ...m, steps: [...m.steps.slice(0, at), step, ...m.steps.slice(at)] });
    setNotice(null);
    select(step.id);
  };

  const addPhase = () => {
    const m = mapRef.current;
    const taken = new Set(m.phases.map((p) => p.id));
    const phase: Phase = { id: uniqueId(slug("New phase"), taken), name: "New phase" };
    commit({ ...m, phases: [...m.phases, phase] });
    setMenu(null);
    setRenaming(phase.id);
  };

  const renamePhase = (phaseId: string, name: string) => {
    const m = mapRef.current;
    const clean = name.trim();
    setRenaming(null);
    if (!clean) return;
    const phase = m.phases.find((p) => p.id === phaseId);
    if (!phase || phase.name === clean) return;
    const used = m.steps.some((s) => s.phase === phaseId);
    const taken = new Set(m.phases.filter((p) => p.id !== phaseId).map((p) => p.id));
    const id = used ? phaseId : uniqueId(slug(clean), taken);
    commit({ ...m, phases: m.phases.map((p) => (p.id === phaseId ? { id, name: clean } : p)) });
  };

  const movePhase = (phaseId: string, dir: -1 | 1) => {
    const m = mapRef.current;
    const i = m.phases.findIndex((p) => p.id === phaseId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= m.phases.length) return;
    const phases = [...m.phases];
    [phases[i], phases[j]] = [phases[j], phases[i]];
    commit({ ...m, phases });
  };

  const removePhase = (phaseId: string) => {
    const m = mapRef.current;
    const n = m.steps.filter((s) => s.phase === phaseId).length;
    if (n) {
      setNotice({ phaseId, where: "header", text: `${n} ${n === 1 ? "step still uses" : "steps still use"} this phase.` });
      return;
    }
    commit({ ...m, phases: m.phases.filter((p) => p.id !== phaseId) });
    setMenu(null);
    setNotice(null);
  };

  /* ----- keyboard ----- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelected(null);
        setMenu(null);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !typing(e.target) && selectedRef.current) {
        e.preventDefault();
        removeStep(selectedRef.current);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [removeStep]);

  /* ----- connectors ----- */

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const origin = wrap.getBoundingClientRect();
    const steps = mapRef.current.steps;
    const out: string[] = [];
    for (let i = 0; i < steps.length - 1; i++) {
      const a = cardRefs.current.get(steps[i].id);
      const b = cardRefs.current.get(steps[i + 1].id);
      if (!a || !b) continue;
      const ra = boxOf(a, origin);
      const rb = boxOf(b, origin);
      const acx = (ra.left + ra.right) / 2;
      const bcx = (rb.left + rb.right) / 2;
      const acy = (ra.top + ra.bottom) / 2;
      const bcy = (rb.top + rb.bottom) / 2;
      if (Math.abs(acx - bcx) < 2) {
        const gap = rb.top - ra.bottom;
        if (gap >= 0 && gap <= 80) out.push(`M${acx} ${ra.bottom + 1}L${bcx} ${rb.top - 4}`);
        continue;
      }
      if (rb.left > ra.right + 8) {
        const x1 = ra.right;
        const x2 = rb.left - 4;
        const mx = (x1 + x2) / 2;
        out.push(`M${x1} ${acy}C${mx} ${acy} ${mx} ${bcy} ${x2} ${bcy}`);
      } else if (rb.right < ra.left - 8) {
        const x1 = ra.left;
        const x2 = rb.right + 4;
        const mx = (x1 + x2) / 2;
        out.push(`M${x1} ${acy}C${mx} ${acy} ${mx} ${bcy} ${x2} ${bcy}`);
      }
    }
    setPaths(out);
  }, []);

  useLayoutEffect(() => {
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [measure, map, wide, selected]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [measure]);

  /* ----- focus after a keyboard move ----- */

  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id) return;
    focusAfter.current = null;
    const el = cardRefs.current.get(id);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    el.focus({ preventScroll: true });
  }, [map]);

  /* ----- touch: stop the page from scrolling while a card is lifted ----- */

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const block = (e: TouchEvent) => {
      if (drag.current?.lifted) e.preventDefault();
    };
    wrap.addEventListener("touchmove", block, { passive: false });
    return () => wrap.removeEventListener("touchmove", block);
  }, []);

  /* ----- drag ----- */

  const siblingTo = useCallback((id: string, el: HTMLDivElement, target: number) => {
    let s = sibs.current.get(id);
    if (!s) {
      s = { pos: 0, vel: 0, target: 0, stop: null };
      sibs.current.set(id, s);
    }
    if (s.target === target) return;
    s.target = target;
    s.stop?.();
    s.stop = null;
    const paint = (v: number) => {
      el.style.transform = v ? `translate3d(0,${v}px,0)` : "";
    };
    if (reducedRef.current) {
      s.pos = target;
      s.vel = 0;
      paint(target);
      return;
    }
    const st = s;
    let last = performance.now();
    st.stop = runSpring({
      from: st.pos,
      to: target,
      velocity: st.vel,
      response: 0.32,
      onFrame: (v) => {
        const now = performance.now();
        const dt = Math.max(1, now - last) / 1000;
        st.vel = (v - st.pos) / dt;
        st.pos = v;
        last = now;
        paint(v);
      },
      onDone: () => {
        st.vel = 0;
        st.stop = null;
      },
    });
  }, []);

  const clearSiblings = useCallback(() => {
    sibs.current.forEach((s) => s.stop?.());
    sibs.current.clear();
    cardRefs.current.forEach((el) => {
      el.style.transform = "";
      el.style.willChange = "";
    });
  }, []);

  const applyTarget = useCallback(
    (d: Drag, phaseId: string, k: number) => {
      d.target = { phaseId, k };
      d.cols.forEach((col) => {
        col.cards.forEach((c, i) => {
          let off = 0;
          if (col.phaseId === d.srcPhase && d.afterInSource.has(c.id)) off -= d.H;
          if (col.phaseId === phaseId && i >= k) off += d.H;
          siblingTo(c.id, c.el, off);
        });
      });
    },
    [siblingTo],
  );

  const lift = useCallback(
    (d: Drag) => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const m = mapRef.current;
      const origin = wrap.getBoundingClientRect();
      const box = boxOf(d.el, origin);
      d.lifted = true;
      d.H = box.height + CARD_GAP;
      d.startX = d.startClientX - origin.left;
      d.startY = d.startClientY - origin.top;
      d.cols = [];
      d.afterInSource = new Set();
      const dragged = m.steps.find((s) => s.id === d.id);
      d.srcPhase = dragged?.phase ?? "";
      m.phases.forEach((phase) => {
        const list = listRefs.current.get(phase.id);
        if (!list) return;
        const cards: DragCol["cards"] = [];
        let seen = false;
        m.steps
          .filter((s) => s.phase === phase.id)
          .forEach((s) => {
            if (s.id === d.id) {
              seen = true;
              d.srcK = cards.length;
              return;
            }
            const el = cardRefs.current.get(s.id);
            if (!el) return;
            if (seen) d.afterInSource.add(s.id);
            cards.push({ id: s.id, box: boxOf(el, origin), el });
          });
        d.cols.push({ phaseId: phase.id, box: boxOf(list, origin), cards });
      });
      if (!m.phases.some((p) => p.id === d.srcPhase)) d.srcK = 0;
      d.target = { phaseId: d.srcPhase, k: d.srcK };
      cardRefs.current.forEach((el) => {
        el.style.willChange = "transform";
      });
      const el = d.el;
      el.style.zIndex = "30";
      el.style.touchAction = "none";
      el.style.cursor = "grabbing";
      el.style.boxShadow = "0 2px 6px rgba(20,32,27,0.08), 0 14px 36px rgba(20,32,27,0.18)";
      el.style.transform = reducedRef.current ? "translate3d(0,0,0)" : "translate3d(0,0,0) scale(1.02)";
      document.body.style.userSelect = "none";
      document.body.style.webkitUserSelect = "none";
      setDragging(true);
      if (wideRef.current) {
        setSelected(d.id);
        setSession((n) => n + 1);
      } else {
        setSelected(null);
      }
    },
    [],
  );

  const settleBack = useCallback(
    (d: Drag, vx: number, vy: number) => {
      const el = d.el;
      const m = /translate3d\((-?[\d.]+)px,(-?[\d.]+)px/.exec(el.style.transform);
      const x0 = m ? parseFloat(m[1]) : 0;
      const y0 = m ? parseFloat(m[2]) : 0;
      let x = x0;
      let y = y0;
      let sc = reducedRef.current ? 1 : 1.02;
      const paint = () => {
        el.style.transform = `translate3d(${x}px,${y}px,0) scale(${sc})`;
      };
      const finish = () => {
        el.style.transform = "";
        el.style.boxShadow = "";
        el.style.zIndex = "";
        el.style.touchAction = "";
        el.style.cursor = "";
        setDragging(false);
        measure();
      };
      if (reducedRef.current) {
        finish();
        return;
      }
      let left = 3;
      const done = () => {
        if (--left === 0) finish();
      };
      runSpring({ from: x0, to: 0, velocity: vx, response: 0.34, onFrame: (v) => { x = v; paint(); }, onDone: done });
      runSpring({ from: y0, to: 0, velocity: vy, response: 0.34, onFrame: (v) => { y = v; paint(); }, onDone: done });
      runFade({ from: 1.02, to: 1, ms: 180, onFrame: (v) => { sc = v; paint(); }, onDone: done });
    },
    [measure],
  );

  const endDrag = useCallback(
    (d: Drag, cancelled: boolean) => {
      drag.current = null;
      if (d.hold) window.clearTimeout(d.hold);
      try {
        d.el.releasePointerCapture(d.pointerId);
      } catch {}
      if (!d.lifted) return;
      document.body.style.userSelect = "";
      document.body.style.webkitUserSelect = "";
      const now = performance.now();
      const recent = d.hist.filter((h) => now - h.t < 120);
      let vx = 0;
      let vy = 0;
      if (recent.length >= 2) {
        const a = recent[0];
        const b = recent[recent.length - 1];
        const dt = Math.max(16, b.t - a.t) / 1000;
        vx = (b.x - a.x) / dt;
        vy = (b.y - a.y) / dt;
      }
      const same = d.target.phaseId === d.srcPhase && d.target.k === d.srcK;
      if (cancelled || same) {
        d.cols.forEach((col) => col.cards.forEach((c) => siblingTo(c.id, c.el, 0)));
        settleBack(d, vx, vy);
        return;
      }
      const r = d.el.getBoundingClientRect();
      flip.current = { id: d.id, cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, vx, vy, stop: [] };
      if (flipFallback.current) window.clearTimeout(flipFallback.current);
      flipFallback.current = window.setTimeout(() => {
        if (!flip.current) return;
        flip.current = null;
        clearSiblings();
        d.el.style.boxShadow = "";
        d.el.style.zIndex = "";
        d.el.style.touchAction = "";
        d.el.style.cursor = "";
        setDragging(false);
        measure();
      }, 400);
      commit(placeStep(mapRef.current, d.id, d.target.phaseId, d.target.k));
    },
    [clearSiblings, commit, measure, settleBack, siblingTo],
  );

  /* the dropped card lands in its new slot from where it was let go */
  useLayoutEffect(() => {
    const f = flip.current;
    if (!f) return;
    const el = cardRefs.current.get(f.id);
    flip.current = null;
    if (flipFallback.current) window.clearTimeout(flipFallback.current);
    flipFallback.current = null;
    clearSiblings();
    if (!el) {
      setDragging(false);
      return;
    }
    el.style.transform = "";
    const r = el.getBoundingClientRect();
    const dx = f.cx - (r.left + r.right) / 2;
    const dy = f.cy - (r.top + r.bottom) / 2;
    const finish = () => {
      el.style.transform = "";
      el.style.boxShadow = "";
      el.style.zIndex = "";
      el.style.touchAction = "";
      el.style.cursor = "";
      el.style.willChange = "";
      setDragging(false);
      measure();
    };
    if (reducedRef.current) {
      finish();
      return;
    }
    let x = dx;
    let y = dy;
    let sc = 1.02;
    el.style.zIndex = "30";
    const paint = () => {
      el.style.transform = `translate3d(${x}px,${y}px,0) scale(${sc})`;
    };
    paint();
    let left = 3;
    const done = () => {
      if (--left === 0) finish();
    };
    runSpring({ from: dx, to: 0, velocity: f.vx, response: 0.36, onFrame: (v) => { x = v; paint(); }, onDone: done });
    runSpring({ from: dy, to: 0, velocity: f.vy, response: 0.36, onFrame: (v) => { y = v; paint(); }, onDone: done });
    runFade({ from: 1.02, to: 1, ms: 220, onFrame: (v) => { sc = v; paint(); }, onDone: done });
  }, [map, clearSiblings, measure]);

  const onCardDown = (id: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    if ((e.target as HTMLElement).closest("button,input,textarea,select,a")) return;
    const el = e.currentTarget;
    const d: Drag = {
      id,
      pointerId: e.pointerId,
      el,
      isTouch: e.pointerType === "touch",
      lifted: false,
      hold: null,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: 0,
      startY: 0,
      cols: [],
      afterInSource: new Set(),
      srcPhase: "",
      srcK: 0,
      target: { phaseId: "", k: 0 },
      H: 0,
      hist: [],
    };
    drag.current = d;
    el.setPointerCapture(e.pointerId);
    if (d.isTouch) {
      d.hold = window.setTimeout(() => {
        d.hold = null;
        if (drag.current === d) lift(d);
      }, HOLD_MS);
    }
  };

  const onCardMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dxc = e.clientX - d.startClientX;
    const dyc = e.clientY - d.startClientY;
    if (!d.lifted) {
      if (d.isTouch) {
        if (Math.hypot(dxc, dyc) > 8) {
          if (d.hold) window.clearTimeout(d.hold);
          drag.current = null;
          try {
            d.el.releasePointerCapture(d.pointerId);
          } catch {}
        }
        return;
      }
      if (Math.hypot(dxc, dyc) < LIFT_PX) return;
      lift(d);
      if (!d.lifted) return;
    }
    const wrap = wrapRef.current;
    if (!wrap) return;
    const origin = wrap.getBoundingClientRect();
    const px = e.clientX - origin.left;
    const py = e.clientY - origin.top;
    const dx = px - d.startX;
    const dy = py - d.startY;
    d.el.style.transform = `translate3d(${dx}px,${dy}px,0)${reducedRef.current ? "" : " scale(1.02)"}`;
    d.hist.push({ t: performance.now(), x: px, y: py });
    if (d.hist.length > 6) d.hist.shift();

    let best: DragCol | null = null;
    let bestD = Infinity;
    d.cols.forEach((col) => {
      const dist = distToBox(px, py, col.box);
      if (dist < bestD) {
        bestD = dist;
        best = col;
      }
    });
    const col = best as DragCol | null;
    if (col && bestD < 140) {
      let k = 0;
      col.cards.forEach((c) => {
        if ((c.box.top + c.box.bottom) / 2 < py) k++;
      });
      if (col.phaseId !== d.target.phaseId || k !== d.target.k) applyTarget(d, col.phaseId, k);
    }

    const sc = scrollRef.current;
    if (sc && wideRef.current) {
      const r = sc.getBoundingClientRect();
      if (e.clientX > r.right - 48) sc.scrollLeft += 12;
      else if (e.clientX < r.left + 48) sc.scrollLeft -= 12;
    }
  };

  const onCardUp = (id: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const wasLifted = d.lifted;
    endDrag(d, false);
    if (!wasLifted) {
      select(selected === id && !wideRef.current ? null : id);
      setMenu(null);
    }
  };

  const onCardCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    endDrag(d, true);
  };

  const onCardKey = (id: string) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      select(id);
    } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      walk(id, e.key === "ArrowUp" ? -1 : 1);
    }
  };

  /* ----- render ----- */

  const editor = selectedStep ? (
    <StepEditor
      key={session}
      step={selectedStep}
      map={map}
      onPatch={patchStep}
      onPhase={setPhase}
      onDuplicate={duplicateStep}
      onWalk={walk}
      onRemove={removeStep}
    />
  ) : null;

  const summary = (["F1", "F2", "AUTO", "F3"] as Filter[])
    .filter((f) => counts[f] > 0)
    .map((f) => {
      const n = counts[f];
      const word = f === "F1" ? "n8n" : f === "F2" ? "extraction" : f === "AUTO" ? (n === 1 ? "agent" : "agents") : n === 1 ? "gate" : "gates";
      return `${n} ${word}`;
    })
    .join(" · ");

  return (
    <div className="min-w-0">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-[#5B6560]">
        <span className="text-[15px] font-medium text-[#14201B]">
          {map.steps.length} {map.steps.length === 1 ? "step" : "steps"}
        </span>
        {summary && <span>{summary}</span>}
      </div>

      <div
        ref={scrollRef}
        className="md:-mx-1 md:overflow-x-auto md:overscroll-x-contain md:px-1 md:pb-3 md:[scrollbar-width:thin] md:[-webkit-overflow-scrolling:touch]"
      >
        <div ref={wrapRef} className="relative flex flex-col gap-7 md:w-max md:min-w-full md:flex-row md:items-start md:gap-8">
          <svg
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 h-full w-full overflow-visible transition-opacity duration-150 motion-reduce:transition-none ${
              dragging ? "opacity-0" : "opacity-100"
            }`}
          >
            <defs>
              <marker id="wf-arrow" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M2 2 7 5 2 8" fill="none" stroke="#8A928C" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </marker>
            </defs>
            {paths.map((p, i) => (
              <path key={i} d={p} fill="none" stroke="#C9CDC8" strokeWidth="1.2" markerEnd="url(#wf-arrow)" />
            ))}
          </svg>

          {columns.map(({ phase, steps, real }, ci) => (
            <section key={phase.id} className="w-full min-w-0 md:w-[264px] md:shrink-0">
              <PhaseHeader
                phase={phase}
                count={steps.length}
                real={real}
                first={ci === 0}
                last={ci === map.phases.length - 1}
                renaming={renaming === phase.id}
                menuOpen={menu === phase.id}
                notice={notice?.phaseId === phase.id && notice.where === "header" ? notice.text : null}
                onRename={(name) => renamePhase(phase.id, name)}
                onStartRename={() => {
                  setRenaming(phase.id);
                  setMenu(null);
                }}
                onCancelRename={() => setRenaming(null)}
                onToggleMenu={() => {
                  setMenu((m) => (m === phase.id ? null : phase.id));
                  setNotice(null);
                }}
                onMove={(dir) => movePhase(phase.id, dir)}
                onRemove={() => removePhase(phase.id)}
              />
              <div
                ref={(el) => {
                  if (el) listRefs.current.set(phase.id, el);
                  else listRefs.current.delete(phase.id);
                }}
                className="flex min-h-[44px] flex-col"
                style={{ gap: CARD_GAP }}
              >
                {steps.map((s) => (
                  <div key={s.id} className="flex flex-col" style={{ gap: CARD_GAP }}>
                    <StepCard
                      step={s}
                      selected={selected === s.id}
                      setRef={(el) => {
                        if (el) cardRefs.current.set(s.id, el);
                        else cardRefs.current.delete(s.id);
                      }}
                      onPointerDown={onCardDown(s.id)}
                      onPointerMove={onCardMove}
                      onPointerUp={onCardUp(s.id)}
                      onPointerCancel={onCardCancel}
                      onKeyDown={onCardKey(s.id)}
                    />
                    {!wide && selected === s.id && editor}
                  </div>
                ))}
              </div>
              {real && (
                <div className="mt-3">
                  <button type="button" className={`${smallBtn} -ml-3`} onClick={() => addStep(phase.id)}>
                    <Ico name="plus" />
                    Add step
                  </button>
                  {notice?.phaseId === phase.id && notice.where === "footer" && (
                    <div className="mt-1 text-[13px] text-[#8A2E2E]">{notice.text}</div>
                  )}
                </div>
              )}
            </section>
          ))}

          <div className="w-full md:w-[264px] md:shrink-0 md:pt-1">
            <button type="button" className={`${ghostBtn} inline-flex w-full items-center justify-center gap-1.5 md:w-auto`} onClick={addPhase}>
              <Ico name="plus" />
              Add phase
            </button>
          </div>
        </div>
      </div>

      {wide && editor && <div className="mt-5">{editor}</div>}
    </div>
  );
}

/* ---------- a phase header ---------- */

function PhaseHeader({
  phase,
  count,
  real,
  first,
  last,
  renaming,
  menuOpen,
  notice,
  onRename,
  onStartRename,
  onCancelRename,
  onToggleMenu,
  onMove,
  onRemove,
}: {
  phase: Phase;
  count: number;
  real: boolean;
  first: boolean;
  last: boolean;
  renaming: boolean;
  menuOpen: boolean;
  notice: string | null;
  onRename: (name: string) => void;
  onStartRename: () => void;
  onCancelRename: () => void;
  onToggleMenu: () => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [value, setValue] = useState(phase.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renaming) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, [renaming]);

  return (
    <div className="mb-3 border-b border-[#E2DFD5] pb-2">
      <div className="flex min-h-11 items-center gap-1">
        {renaming ? (
          <input
            ref={inputRef}
            className={`${inputCls} min-h-10 py-1.5 text-[15px] font-medium`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={() => onRename(value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onRename(value);
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setValue(phase.name);
                onCancelRename();
              }
            }}
            aria-label="Phase name"
          />
        ) : (
          <button
            type="button"
            disabled={!real}
            onClick={() => {
              setValue(phase.name);
              onStartRename();
            }}
            className="min-h-11 min-w-0 flex-1 truncate rounded-lg px-1 text-left text-[15px] font-medium text-[#14201B] transition-[background-color] [@media(hover:hover)]:hover:bg-[#14201B]/[0.05] disabled:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#14201B]/50"
          >
            {phase.name}
          </button>
        )}
        <span className="shrink-0 px-1 text-[13px] text-[#8A928C]">{count}</span>
        {real && (
          <button type="button" className={iconBtn} aria-label="Phase menu" aria-expanded={menuOpen} onClick={onToggleMenu}>
            <Ico name="more" />
          </button>
        )}
      </div>
      {menuOpen && real && (
        <div className="mt-1 flex flex-wrap items-center gap-0.5">
          <button type="button" className={smallBtn} onClick={onStartRename}>
            <Ico name="edit" size={14} />
            Rename
          </button>
          <button type="button" className={iconBtn} aria-label="Move phase left" disabled={first} onClick={() => onMove(-1)}>
            <Ico name="chevron-left" />
          </button>
          <button type="button" className={iconBtn} aria-label="Move phase right" disabled={last} onClick={() => onMove(1)}>
            <Ico name="chevron-right" />
          </button>
          <button type="button" className={`${smallBtn} text-[#8A2E2E]`} onClick={onRemove}>
            <LocalIco name="trash" size={14} />
            Remove
          </button>
        </div>
      )}
      {notice && <div className="mt-1 text-[13px] text-[#8A2E2E]">{notice}</div>}
    </div>
  );
}

/* ---------- a step card ---------- */

function StepCard({
  step,
  selected,
  setRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onKeyDown,
}: {
  step: Step;
  selected: boolean;
  setRef: (el: HTMLDivElement | null) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const gate = step.filter === "F3";
  const actors = [step.actorNow, step.actorTarget].filter((a) => a && a.trim());
  return (
    <div
      ref={setRef}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
      className={`relative min-h-11 cursor-grab select-none rounded-xl border bg-white px-3.5 py-3 text-left outline-none [-webkit-touch-callout:none] ${
        gate ? "border-l-[3px] border-l-[#14201B] pl-3" : ""
      } ${selected ? "border-[#14201B] ring-2 ring-[#14201B]" : "border-[#E2DFD5]"} focus-visible:ring-2 focus-visible:ring-[#14201B]/50`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[13px] text-[#8A928C]">{step.id}</div>
          <div className="text-[15px] font-medium leading-snug text-[#14201B]">{step.name}</div>
        </div>
        <div className="shrink-0 pt-0.5">
          <FilterChip filter={step.filter} />
        </div>
      </div>
      {actors.length > 0 && <div className="mt-1.5 text-[13px] text-[#5B6560]">{actors.join(" → ")}</div>}
      {step.tool && step.tool.trim() && <div className="mt-1 truncate text-[13px] text-[#5B6560]">{step.tool}</div>}
    </div>
  );
}
