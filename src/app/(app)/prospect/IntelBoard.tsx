"use client";

/**
 * The Prospect dashboard. First fold: training (practice and the sale's
 * roadmap, which need no data and paint at once). Then today (summary,
 * pulse, playbook progress) and outbound across channels. Last: the
 * intelligence columns, a snap row on the phone, side by side on a wide
 * screen.
 *
 * It paints from the phone's last answer at once (peekJson) and swaps the
 * fresh one in underneath (getJson). Both land in the same shape, so nothing
 * moves when the fresh answer arrives. Before any answer exists, a skeleton
 * the same shape holds the place.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Card, SkeletonBar } from "../../../lib/core/ui";
import { getJson, peekJson } from "../../../lib/core/api";
import type { IntelChannel, IntelPayload } from "../../../lib/features/prospect/intel";
import { FollowupsColumn, PlaybookColumn, RankedColumn, STATUS, ScanColumn, SequencesColumn, SocialsColumn } from "./IntelColumns";
import { Glyph, channelGlyph, plainPast, pressCls } from "./intel-ui";
import { Training } from "./Training";

const PATH = "/api/prospect/intel";
const num = "[font-variant-numeric:tabular-nums]";
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type ColKey = "ranked" | "followups" | "sequences" | "scan" | "socials" | "playbook";

function isPayload(p: unknown): p is IntelPayload {
  const d = p as Partial<IntelPayload> | null;
  return (
    !!d &&
    d.ok === true &&
    !!d.pulse &&
    Array.isArray(d.channels) &&
    Array.isArray(d.followups) &&
    Array.isArray(d.sequences) &&
    Array.isArray(d.ranked) &&
    !!d.socials &&
    Array.isArray(d.socials.top) &&
    !!d.scan &&
    !!d.playbook &&
    Array.isArray(d.playbook.sections)
  );
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

function useIntel(): { data: IntelPayload | null; failed: boolean; retry: () => void } {
  const [data, setData] = useState<IntelPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const have = useRef(false);

  const apply = useCallback((p: unknown): boolean => {
    if (!isPayload(p)) return false;
    have.current = true;
    setData((prev) => (prev && prev.builtAt >= p.builtAt ? prev : p));
    return true;
  }, []);

  /* The phone's copy, before the first paint. The server render and the
     first client render are both the skeleton, so hydration matches. */
  useIsoLayoutEffect(() => {
    apply(peekJson<IntelPayload>(PATH));
  }, [apply]);

  const load = useCallback(() => {
    getJson<unknown>(PATH)
      .then((j) => {
        if (apply(j)) setFailed(false);
        else if (!have.current) setFailed(true);
      })
      .catch(() => {
        if (!have.current) setFailed(true);
      });
  }, [apply]);

  useEffect(() => {
    load();
    /* The disk copy reads in a moment after mount; look again a few times
       until it lands or the fresh answer does. */
    const timers = [50, 150, 350, 800].map((ms) =>
      window.setTimeout(() => {
        if (!have.current) apply(peekJson<IntelPayload>(PATH));
      }, ms),
    );
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - last < 60_000) return;
      last = Date.now();
      load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      timers.forEach(window.clearTimeout);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [apply, load]);

  return {
    data,
    failed,
    retry: () => {
      setFailed(false);
      load();
    },
  };
}

/* ------------------------------------------------------------------ */
/* First fold                                                          */
/* ------------------------------------------------------------------ */

function Summary({ text, at }: { text: string; at: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 260;
  const stamp = plainPast(at);
  return (
    <div className="mb-4">
      <p className={`text-[15px] leading-[1.5] whitespace-pre-line text-[#14201B] ${long && !open ? "line-clamp-4" : ""}`}>{text}</p>
      <div className="mt-1 flex items-center justify-between gap-3">
        {long ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className={`-ml-2 min-h-11 rounded-md px-2 text-[13.5px] font-medium text-[#5B6560] ${pressCls}`}
          >
            {open ? "Show less" : "Read more"}
          </button>
        ) : (
          <span />
        )}
        {stamp && stamp !== "today" && <span className="text-[12px] text-[#8A928C]">{stamp}</span>}
      </div>
    </div>
  );
}

function PulseCell({ value, label, note, onPress }: { value: number; label: string; note?: string; onPress: () => void }) {
  return (
    <button
      type="button"
      onClick={onPress}
      className={`flex min-h-[76px] min-w-0 flex-col items-start rounded-md px-2 py-2 text-left ${pressCls}`}
    >
      <span className={`text-[28px] leading-none font-semibold tracking-[-0.02em] text-[#14201B] ${num}`}>{value}</span>
      <span className="mt-1.5 text-[13px] leading-tight font-medium whitespace-nowrap text-[#14201B]">{label}</span>
      {note && <span className={`mt-0.5 text-[11.5px] leading-tight whitespace-nowrap text-[#8A928C] ${num}`}>{note}</span>}
    </button>
  );
}

function TodayCard({ d, go }: { d: IntelPayload; go: (k: ColKey) => void }) {
  const p = d.pulse;
  const pb = d.playbook;
  return (
    <Card className="p-4!">
      <h2 className="mb-3 text-[15px] font-semibold tracking-[-0.01em] text-[#14201B]">Today</h2>
      {d.summary && <Summary text={d.summary.text} at={d.summary.at} />}
      <div className="-mx-2 grid grid-cols-[1.35fr_0.75fr_1fr_0.7fr] gap-0.5">
        <PulseCell value={p.touchesWeek} label="Touches" note={`${p.touchesPrevWeek} last week`} onPress={() => go("sequences")} />
        <PulseCell value={p.followupsDue} label="Due" onPress={() => go("followups")} />
        <PulseCell value={p.newLeads14} label="New leads" onPress={() => go("scan")} />
        <PulseCell value={p.rankedNow} label="Now" onPress={() => go("ranked")} />
      </div>
      {pb.sections.length > 0 && (
        <button
          type="button"
          onClick={() => go("playbook")}
          className={`-mx-2 mt-2 flex min-h-11 w-[calc(100%+1rem)] items-center gap-3 rounded-md border-t border-[#EDEBE3] px-2 pt-2 text-left ${pressCls}`}
        >
          <span className="text-[13px] font-medium text-[#14201B]">Playbook</span>
          <span className="flex h-1.5 flex-1 gap-0.5" aria-hidden="true">
            {pb.sections.map((s) => (
              <span key={s.n} className="flex-1 rounded-full" style={{ background: STATUS[s.status]?.fill ?? "#E6E3D8" }} />
            ))}
          </span>
          <span className={`shrink-0 text-[12.5px] text-[#5B6560] ${num}`}>
            {pb.tested} of {pb.sections.length} field-tested
          </span>
        </button>
      )}
    </Card>
  );
}

function Strip({ ch }: { ch: IntelChannel }) {
  const max = Math.max(1, ...ch.days);
  return (
    <div
      className="flex h-[26px] flex-1 items-end gap-0.5"
      role="img"
      aria-label={`${ch.label}, last 14 days: ${ch.days.join(", ")}`}
    >
      {ch.days.map((n, i) => (
        <div
          key={i}
          className="min-w-0 flex-1 rounded-[2px]"
          style={{
            height: n > 0 ? `${Math.max(18, (n / max) * 100)}%` : 2,
            background: n === 0 ? "#E2DFD5" : i === ch.days.length - 1 ? "#14201B" : "#A9AFA9",
          }}
        />
      ))}
    </div>
  );
}

function OutboundCard({ d }: { d: IntelPayload }) {
  if (d.channels.length === 0 && d.draftsPending === 0) return null;
  return (
    <Card className="p-4!">
      <div className="mb-2 flex min-h-6 items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[#14201B]">Outbound</h2>
        {d.draftsPending > 0 && (
          <span className={`rounded-full bg-[#F3E3C6] px-2.5 py-1 text-[12px] leading-none font-medium text-[#8A6D2F] ${num}`}>
            {d.draftsPending} drafts pending
          </span>
        )}
      </div>
      <ul>
        {d.channels.map((ch, i) => (
          <li key={ch.key} className={`flex min-h-11 items-center gap-2.5 py-1.5 ${i > 0 ? "border-t border-[#EDEBE3]" : ""}`}>
            <span className="w-[92px] shrink-0">
              <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-[#14201B]">
                <span className="text-[#5B6560]">
                  <Glyph name={channelGlyph(ch.key)} size={14} />
                </span>
                {ch.label}
              </span>
              <span className={`block pl-5 text-[11.5px] leading-tight text-[#8A928C] ${num}`}>{ch.prevWeek} last week</span>
            </span>
            <span className={`w-7 shrink-0 text-right text-[17px] font-semibold text-[#14201B] ${num}`}>{ch.week}</span>
            <Strip ch={ch} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Second fold                                                         */
/* ------------------------------------------------------------------ */

function columnsOf(d: IntelPayload): { key: ColKey; label: string; node: ReactNode; wide?: boolean }[] {
  const s = d.scan;
  const scanHas =
    s.new14.length > 0 || s.scoutGrades.length > 0 || s.dormantFit.good + s.dormantFit.notFit > 0 || s.awaitingFirstTouch.length > 0 || !!s.lastScanAt;
  const socialsHas = d.socials.book > 0 || d.socials.top.length > 0;
  const out: { key: ColKey; label: string; node: ReactNode; wide?: boolean }[] = [];
  if (d.followups.length) out.push({ key: "followups", label: "Follow-ups", node: <FollowupsColumn d={d} /> });
  if (d.sequences.length) out.push({ key: "sequences", label: "Sequences", node: <SequencesColumn d={d} /> });
  if (scanHas) out.push({ key: "scan", label: "Scan", node: <ScanColumn d={d} /> });
  if (socialsHas) out.push({ key: "socials", label: "Socials", node: <SocialsColumn d={d} /> });
  if (d.playbook.sections.length) out.push({ key: "playbook", label: "Playbook", node: <PlaybookColumn d={d} />, wide: true });
  if (d.ranked.length) out.push({ key: "ranked", label: "Ranked", node: <RankedColumn d={d} /> });
  return out;
}

const bleed = "-mx-5 px-5 md:-mx-9 md:px-9";

function Columns({ cols, sectionRef, registerGo }: { cols: ReturnType<typeof columnsOf>; sectionRef: RefObject<HTMLElement | null>; registerGo: (fn: (k: ColKey) => void) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<ColKey>(cols[0]?.key ?? "followups");
  const lockUntil = useRef(0);
  const raf = useRef(0);

  const jump = useCallback(
    (key: ColKey, page: boolean) => {
      const el = scroller.current;
      if (!el) return;
      const i = cols.findIndex((c) => c.key === key);
      const kid = el.children[i] as HTMLElement | undefined;
      if (!kid) return;
      const behavior: ScrollBehavior = reducedMotion() ? "auto" : "smooth";
      setActive(key);
      lockUntil.current = Date.now() + 700;
      el.scrollTo({ left: kid.offsetLeft - (el.children[0] as HTMLElement).offsetLeft, behavior });
      if (page) sectionRef.current?.scrollIntoView({ block: "start", behavior });
    },
    [cols, sectionRef],
  );

  useEffect(() => {
    registerGo((k) => jump(k, true));
  }, [jump, registerGo]);

  const onScroll = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = scroller.current;
      if (!el || Date.now() < lockUntil.current) return;
      const kids = Array.from(el.children) as HTMLElement[];
      if (kids.length === 0) return;
      const base = kids[0].offsetLeft;
      let idx = 0;
      let best = Infinity;
      kids.forEach((k, i) => {
        const dist = Math.abs(k.offsetLeft - base - el.scrollLeft);
        if (dist < best) {
          best = dist;
          idx = i;
        }
      });
      if (el.scrollLeft + el.clientWidth >= el.scrollWidth - 4) idx = kids.length - 1;
      const key = cols[idx]?.key;
      if (key) setActive((cur) => (cur === key ? cur : key));
    });
  }, [cols]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  /* Keep the active tab in view inside the strip, without moving the page. */
  useEffect(() => {
    const s = strip.current;
    const t = s?.querySelector<HTMLElement>(`[data-tab="${active}"]`);
    if (!s || !t) return;
    const left = t.offsetLeft - (s.clientWidth - t.offsetWidth) / 2;
    s.scrollTo({ left, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [active]);

  return (
    <section ref={sectionRef} className="@container mt-5 scroll-mt-2">
      <div
        className={`sticky top-[env(safe-area-inset-top,0px)] z-20 ${bleed} bg-[#F7F6F1]/90 py-2 backdrop-blur-md`}
      >
        <div
          ref={strip}
          role="tablist"
          aria-label="Intelligence"
          className="flex gap-1 overflow-x-auto rounded-xl bg-[#EDEBE3] p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {cols.map((c) => {
            const on = c.key === active;
            return (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={on}
                data-tab={c.key}
                onClick={() => jump(c.key, false)}
                className={`min-h-11 shrink-0 touch-manipulation rounded-lg px-3.5 text-[13.5px] transition-[transform,background-color,color,box-shadow] duration-150 select-none active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 ${
                  on ? "bg-white font-semibold text-[#14201B] shadow-[0_1px_2px_rgba(20,32,27,0.12)]" : "font-medium text-[#5B6560]"
                }`}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className={`${bleed} flex snap-x snap-mandatory items-start gap-3 overflow-x-auto overscroll-x-contain pt-1 pb-4 [scroll-padding-inline:1.25rem] [scrollbar-width:none] md:[scroll-padding-inline:2.25rem] [&::-webkit-scrollbar]:hidden @min-[1000px]:[scrollbar-width:thin]`}
      >
        {cols.map((c) => (
          <div
            key={c.key}
            className={`w-[86%] min-w-0 shrink-0 snap-start @min-[1000px]:w-[360px] ${c.wide ? "@min-[1000px]:w-[440px]" : ""}`}
          >
            {c.node}
          </div>
        ))}
        <div className="w-px shrink-0 md:hidden" aria-hidden="true" />
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

export function IntelBoard() {
  const { data, failed, retry } = useIntel();
  const sectionRef = useRef<HTMLElement | null>(null);
  const goRef = useRef<(k: ColKey) => void>(() => {});
  const registerGo = useCallback((fn: (k: ColKey) => void) => {
    goRef.current = fn;
  }, []);
  const go = useCallback((k: ColKey) => goRef.current(k), []);

  if (!data) {
    return (
      <div className="mb-6">
        <Training />
        {failed ? (
          <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-[#E2DFD5] bg-white px-4 py-2">
            <span className="text-[14px] text-[#B5372A]">The dashboard did not load.</span>
            <button type="button" onClick={retry} className={`-mr-2 min-h-11 rounded-md px-3 text-[14px] font-medium text-[#14201B] ${pressCls}`}>
              Try again
            </button>
          </div>
        ) : (
          <BoardSkeleton />
        )}
      </div>
    );
  }

  const cols = columnsOf(data);
  return (
    <div className="mb-6">
      <Training />
      <div className="flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
        <TodayCard d={data} go={go} />
        <OutboundCard d={data} />
      </div>
      {cols.length > 0 && <Columns key={cols.map((c) => c.key).join()} cols={cols} sectionRef={sectionRef} registerGo={registerGo} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Skeletons                                                           */
/* ------------------------------------------------------------------ */

function BoardSkeleton() {
  return (
    <div aria-busy="true">
      <div className="flex flex-col gap-3 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
        <Card className="p-4!">
          <SkeletonBar className="mb-3 h-5 w-14" />
          <div className="-mx-2 grid grid-cols-[1.35fr_0.75fr_1fr_0.7fr] gap-0.5">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex min-h-[76px] flex-col gap-2 px-2 py-2">
                <SkeletonBar className="h-7 w-10" />
                <SkeletonBar className="h-3 w-12" />
              </div>
            ))}
          </div>
          <div className="mt-2 flex min-h-11 items-center gap-3 border-t border-[#EDEBE3] pt-2">
            <SkeletonBar className="h-3.5 w-14" />
            <SkeletonBar className="h-1.5 flex-1" />
            <SkeletonBar className="h-3.5 w-24" />
          </div>
        </Card>
        <Card className="p-4!">
          <SkeletonBar className="mb-2 h-6 w-20" />
          {[0, 1, 2].map((i) => (
            <div key={i} className={`flex min-h-11 items-center gap-2.5 py-1.5 ${i > 0 ? "border-t border-[#EDEBE3]" : ""}`}>
              <SkeletonBar className="h-8 w-[92px]" />
              <SkeletonBar className="h-5 w-7" />
              <SkeletonBar className="h-[26px] flex-1" />
            </div>
          ))}
        </Card>
      </div>
      <div className="mt-5">
        <div className={`${bleed} py-2`}>
          <SkeletonBar className="h-[52px] w-full rounded-xl" />
        </div>
        <Card className="mt-1 w-[86%] p-4!">
          <SkeletonBar className="mb-4 h-5 w-24" />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex gap-3 py-2.5">
              <SkeletonBar className="h-7 w-9" />
              <div className="flex flex-1 flex-col gap-2">
                <SkeletonBar className="h-4 w-4/5" />
                <SkeletonBar className="h-3 w-full" />
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

/** The call list's place while it streams in: a search field, a few days, a panel. */
export function IntelListSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true">
      <SkeletonBar className="h-11 w-full" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-lg border border-[#E2DFD5] bg-white p-3">
          <SkeletonBar className="mb-3 h-4 w-28" />
          <SkeletonBar className="mb-2 h-11 w-full" />
          <SkeletonBar className="h-11 w-full" />
        </div>
      ))}
      <div className="h-40 rounded-lg border border-dashed border-[#D8D4C8]" />
    </div>
  );
}
