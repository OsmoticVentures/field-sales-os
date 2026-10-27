"use client";

/**
 * The first fold of Prospect: Practice (one drill card at a time, five a
 * day) beside the sale's Roadmap (nine stages). Both read the playbook
 * generated from the agency repo, word for word. Progress stays on the phone
 * (practice.ts), keyed by rep.
 *
 * MOTION: a card leaves to the left and the next arrives from the right
 * (same path out and in), the revealed line rises in on a critically damped
 * spring, every button answers on press. Reduced motion turns each of those
 * into a short fade.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Card, Ico, primaryBtn, ghostBtn } from "../../../lib/core/ui";
import { currentRep } from "../../../lib/core/phone-store";
import { DRILLS, SALE_ROADMAP, type Drill } from "../../../lib/features/prospect/playbook.generated";
import {
  SET_SIZE,
  doneToday,
  emptyPractice,
  loadPractice,
  pick,
  record,
  savePractice,
  todayKey,
  type Answer,
  type Practice,
} from "../../../lib/features/prospect/practice";
import { pressCls } from "./intel-ui";

const num = "[font-variant-numeric:tabular-nums]";
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const stageOf = (key: string) => SALE_ROADMAP.find((s) => s.key === key);
const stageNo = (key: string) => SALE_ROADMAP.findIndex((s) => s.key === key) + 1;
const drillsIn = (key: string) => DRILLS.filter((d) => d.stage === key).length;

/* ------------------------------------------------------------------ */
/* Motion                                                              */
/* ------------------------------------------------------------------ */

function reduced(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let springCache: string | null = null;
/** A critically damped spring (no overshoot, about 0.4s to rest) as a CSS
 *  linear() easing, so a Web Animation settles like a spring and can be
 *  replaced mid-flight. Older Safari gets the house ease-out instead. */
function spring(): string {
  if (springCache) return springCache;
  if (typeof CSS === "undefined" || !CSS.supports("animation-timing-function", "linear(0, 1)")) {
    return (springCache = "cubic-bezier(0.23, 1, 0.32, 1)");
  }
  const w = 13;
  const steps = 22;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const v = i === steps ? 1 : 1 - (1 + w * t) * Math.exp(-w * t);
    pts.push(v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
  }
  return (springCache = `linear(${pts.join(", ")})`);
}

function play(el: HTMLElement | null, frames: Keyframe[], opts: KeyframeAnimationOptions): Promise<void> {
  if (!el || typeof el.animate !== "function") return Promise.resolve();
  return el.animate(frames, opts).finished.then(
    () => undefined,
    () => undefined,
  );
}

const fadeOnly = (from: number, to: number): Keyframe[] => [{ opacity: from }, { opacity: to }];

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

type SetState = { queue: Drill[]; idx: number; base: number; size: number; done: boolean };

const EMPTY_SET: SetState = { queue: [], idx: 0, base: 0, size: SET_SIZE, done: false };

function dailySet(p: Practice, date: string): SetState {
  const n = doneToday(p, date).n;
  if (n > 0 && n % SET_SIZE === 0) return { ...EMPTY_SET, done: true };
  const base = n % SET_SIZE;
  return { queue: pick(p, date, SET_SIZE - base, null), idx: 0, base, size: SET_SIZE, done: false };
}

export function Training() {
  const [ready, setReady] = useState(false);
  const [prog, setProg] = useState<Practice>(emptyPractice);
  const [set, setSet] = useState<SetState>(EMPTY_SET);
  const [filter, setFilter] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const rep = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const prevId = useRef<string | null>(null);

  useIsoLayoutEffect(() => {
    rep.current = currentRep();
    const p = loadPractice(rep.current);
    setProg(p);
    setSet(dailySet(p, todayKey()));
    setReady(true);
  }, []);

  const card = !set.done ? set.queue[set.idx] : undefined;
  const cardStage = card?.stage ?? null;
  const shownStage = picked ?? cardStage ?? SALE_ROADMAP[0]?.key ?? "";

  /* A new card arrives from the right on the spring. */
  const cardId = card?.id ?? (set.done ? "done" : "");
  useIsoLayoutEffect(() => {
    const before = prevId.current;
    prevId.current = cardId;
    /* The first card the page shows is not an arrival. */
    if (before === null || before === "") return;
    /* The leaving card's held end state must not outlive it. */
    bodyRef.current?.getAnimations().forEach((a) => a.cancel());
    if (reduced()) void play(bodyRef.current, fadeOnly(0, 1), { duration: 120, easing: "ease-out" });
    else
      void play(
        bodyRef.current,
        [
          { opacity: 0, transform: "translateX(28px)" },
          { opacity: 1, transform: "translateX(0)" },
        ],
        { duration: 440, easing: spring() },
      );
  }, [cardId]);

  const startSet = useCallback(
    (stage: string | null, p: Practice) => {
      const date = todayKey();
      const queue = pick(p, date, SET_SIZE, stage);
      setSet({ queue, idx: 0, base: 0, size: queue.length, done: queue.length === 0 });
      setShown(false);
      setPicked(null);
    },
    [],
  );

  const choose = useCallback(
    async (ans: Answer) => {
      if (busy.current || !card) return;
      busy.current = true;
      const date = todayKey();
      const next = record(prog, card.id, ans, date);
      setProg(next);
      savePractice(rep.current, next);
      if (reduced()) await play(bodyRef.current, fadeOnly(1, 0), { duration: 90, easing: "ease-out", fill: "forwards" });
      else
        await play(
          bodyRef.current,
          [
            { opacity: 1, transform: "translateX(0)" },
            { opacity: 0, transform: "translateX(-28px)" },
          ],
          { duration: 150, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "forwards" },
        );
      setShown(false);
      setPicked(null);
      setSet((s) => (s.idx + 1 >= s.queue.length ? { ...s, done: true } : { ...s, idx: s.idx + 1 }));
      busy.current = false;
    },
    [card, prog],
  );

  const setStageFilter = useCallback(
    (stage: string | null) => {
      setFilter(stage);
      if (stage === null) setSet(dailySet(prog, todayKey()));
      else startSet(stage, prog);
      setShown(false);
      setPicked(null);
    },
    [prog, startSet],
  );

  const more = useCallback(() => {
    if (filter) startSet(filter, prog);
    else {
      const date = todayKey();
      const queue = pick(prog, date, SET_SIZE, null);
      setSet({ queue, idx: 0, base: 0, size: queue.length, done: queue.length === 0 });
      setShown(false);
      setPicked(null);
    }
  }, [filter, prog, startSet]);

  if (DRILLS.length === 0 && SALE_ROADMAP.length === 0) return null;

  const today = doneToday(prog, todayKey());

  return (
    <div className="mb-3 flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
      {DRILLS.length > 0 && (
        <PracticeCard
          ready={ready}
          card={card}
          set={set}
          filter={filter}
          shown={shown}
          reveal={() => setShown(true)}
          choose={choose}
          clearFilter={() => setStageFilter(null)}
          more={more}
          today={today}
          bodyRef={bodyRef}
        />
      )}
      {SALE_ROADMAP.length > 0 && (
        <RoadmapCard
          current={cardStage}
          selected={shownStage}
          filter={filter}
          onSelect={(k) => setPicked(k)}
          onFilter={(k) => setStageFilter(k)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Practice                                                            */
/* ------------------------------------------------------------------ */

function PracticeCard({
  ready,
  card,
  set,
  filter,
  shown,
  reveal,
  choose,
  clearFilter,
  more,
  today,
  bodyRef,
}: {
  ready: boolean;
  card: Drill | undefined;
  set: SetState;
  filter: string | null;
  shown: boolean;
  reveal: () => void;
  choose: (a: Answer) => void;
  clearFilter: () => void;
  more: () => void;
  today: { n: number; got: number };
  bodyRef: RefObject<HTMLDivElement | null>;
}) {
  const lineRef = useRef<HTMLDivElement>(null);
  useIsoLayoutEffect(() => {
    if (!shown) return;
    if (reduced()) void play(lineRef.current, fadeOnly(0, 1), { duration: 120, easing: "ease-out" });
    else
      void play(
        lineRef.current,
        [
          { opacity: 0, transform: "translateY(10px) scale(0.985)" },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ],
        { duration: 420, easing: spring() },
      );
  }, [shown]);

  const st = card ? stageOf(card.stage) : undefined;
  const filterStage = filter ? stageOf(filter) : undefined;

  return (
    <Card className="p-4!">
      <div className="mb-3 flex min-h-6 items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#14201B]">Practice</h2>
        {card && (
          <span className={`text-[13px] text-[#5B6560] ${num}`}>
            {set.base + set.idx + 1} of {set.size}
          </span>
        )}
      </div>

      {filterStage && (
        <button
          type="button"
          onClick={clearFilter}
          aria-label={`${filterStage.title} only. Show all stages`}
          className={`-mt-1 mb-2 inline-flex min-h-11 items-center gap-1.5 rounded-full bg-[#EDEBE3] pr-3 pl-3.5 text-[13.5px] font-medium text-[#14201B] ${pressCls}`}
        >
          {filterStage.title}
          <Ico name="close" size={12} />
        </button>
      )}

      <div ref={bodyRef} aria-live="polite">
        {!ready ? (
          <PracticeSkeleton />
        ) : card && st ? (
          <>
            <p className="text-[12.5px] font-medium text-[#5B6560]">
              <span className={num}>{stageNo(st.key)}</span> {st.title}
            </p>
            <p className="mt-1.5 text-[19px] leading-[1.3] font-semibold tracking-[-0.012em] text-balance text-[#14201B]">{cap(card.cue)}</p>

            {!shown ? (
              <button type="button" onClick={reveal} className={`${primaryBtn} mt-4 min-h-12! w-full text-[15px]`}>
                Show line
              </button>
            ) : (
              <>
                <div ref={lineRef} className="mt-4 rounded-md bg-[#F7F6F1] px-3.5 py-3 will-change-transform">
                  <p className="text-[16.5px] leading-[1.45] text-pretty text-[#14201B]">{cap(card.line)}</p>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => choose("again")} className={`${ghostBtn} min-h-12! text-[15px]`}>
                    Again
                  </button>
                  <button type="button" onClick={() => choose("got")} className={`${primaryBtn} min-h-12! text-[15px]`}>
                    Got it
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <div>
            <p className={`text-[34px] leading-none font-semibold tracking-[-0.02em] text-[#14201B] ${num}`}>{today.n}</p>
            <p className="mt-1.5 text-[14.5px] text-[#5B6560]">done today</p>
            {today.n > 0 && today.got > 0 && (
              <p className={`mt-0.5 text-[13px] text-[#8A928C] ${num}`}>{today.got} got it</p>
            )}
            <button type="button" onClick={more} className={`${primaryBtn} mt-4 min-h-12! w-full text-[15px]`}>
              Practice more
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}

function PracticeSkeleton() {
  return (
    <div aria-busy="true">
      <div className="h-3.5 w-24 animate-pulse rounded-md bg-[#EDEBE3] motion-reduce:animate-none" />
      <div className="mt-3 h-5 w-full animate-pulse rounded-md bg-[#EDEBE3] motion-reduce:animate-none" />
      <div className="mt-2 h-5 w-4/5 animate-pulse rounded-md bg-[#EDEBE3] motion-reduce:animate-none" />
      <div className="mt-4 h-12 w-full animate-pulse rounded-xl bg-[#EDEBE3] motion-reduce:animate-none" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Roadmap                                                             */
/* ------------------------------------------------------------------ */

function RoadmapCard({
  current,
  selected,
  filter,
  onSelect,
  onFilter,
}: {
  current: string | null;
  selected: string;
  filter: string | null;
  onSelect: (k: string) => void;
  onFilter: (k: string | null) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  const stage = stageOf(selected) ?? SALE_ROADMAP[0];
  const count = drillsIn(stage.key);

  /* Keep the selected stage centered in the rail, without moving the page. */
  useEffect(() => {
    const r = rail.current;
    const chip = r?.querySelector<HTMLElement>(`[data-stage="${selected}"]`);
    if (!r || !chip) return;
    r.scrollTo({ left: chip.offsetLeft - (r.clientWidth - chip.offsetWidth) / 2, behavior: first.current || reduced() ? "auto" : "smooth" });
  }, [selected]);

  /* The detail rises in when the stage changes. */
  useIsoLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduced()) void play(panel.current, fadeOnly(0, 1), { duration: 120, easing: "ease-out" });
    else
      void play(
        panel.current,
        [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "translateY(0)" },
        ],
        { duration: 380, easing: spring() },
      );
  }, [selected]);

  return (
    <Card className="p-4!">
      <div className="mb-1 flex min-h-6 items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#14201B]">Roadmap</h2>
        <span className={`text-[13px] text-[#5B6560] ${num}`}>{SALE_ROADMAP.length} stages</span>
      </div>

      <div
        ref={rail}
        role="tablist"
        aria-label="Stages of the sale"
        className="-mx-4 flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain px-4 [scroll-padding-inline:1rem] [mask-image:linear-gradient(to_right,transparent,#000_20px,#000_calc(100%-20px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="relative flex w-max">
          <span aria-hidden="true" className="absolute top-[22px] right-10 left-10 h-px bg-[#E2DFD5]" />
          {SALE_ROADMAP.map((s, i) => {
            const on = s.key === selected;
            const live = s.key === current;
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={on}
                aria-current={live ? "step" : undefined}
                data-stage={s.key}
                onClick={() => onSelect(s.key)}
                className="group relative flex min-h-[76px] w-20 shrink-0 touch-manipulation snap-center flex-col items-center gap-1.5 px-1 pt-2 pb-1 select-none"
              >
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full border text-[13px] font-semibold transition-[transform,background-color,color,border-color,box-shadow] duration-150 ease-out group-active:scale-90 motion-reduce:transition-none motion-reduce:group-active:scale-100 ${num} ${
                    on
                      ? "border-[#14201B] bg-[#14201B] text-[#F7F6F1]"
                      : live
                        ? "border-[#2C6A46] bg-[#E1EDE5] text-[#2C6A46]"
                        : "border-[#D8D4C8] bg-white text-[#5B6560]"
                  } ${live ? "shadow-[0_0_0_3px_#E1EDE5]" : ""}`}
                >
                  {i + 1}
                </span>
                <span className={`line-clamp-2 text-center text-[12px] leading-[1.2] ${on ? "font-semibold text-[#14201B]" : "text-[#5B6560]"}`}>{s.title}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div ref={panel} className="mt-2 border-t border-[#EDEBE3] pt-3.5" role="tabpanel">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-[#14201B]">{stage.title}</h3>
          <span className={`shrink-0 text-[12px] text-[#8A928C] ${num}`}>Section {stage.section}</span>
        </div>
        <p className="mt-1.5 text-[16.5px] leading-[1.42] text-pretty text-[#14201B]">{cap(stage.say)}</p>
        {stage.points.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {stage.points.map((p, i) => (
              <li key={i} className="border-l-2 border-[#E2DFD5] pl-3 text-[14px] leading-[1.45] text-pretty text-[#3D4A44]">
                {cap(p)}
              </li>
            ))}
          </ul>
        )}
        {count > 0 && (
          <button
            type="button"
            onClick={() => onFilter(filter === stage.key ? null : stage.key)}
            className={`${ghostBtn} mt-3.5 inline-flex min-h-11 items-center gap-1.5`}
          >
            {filter === stage.key ? "Practice all stages" : "Practice this stage"}
            <span className={`text-[#8A928C] ${num}`}>{count}</span>
          </button>
        )}
      </div>
    </Card>
  );
}
