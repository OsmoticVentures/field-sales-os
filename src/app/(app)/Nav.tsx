"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { warmJson } from "../../lib/core/api";
import { Ico } from "../../lib/core/ui";
import { sees, useMe } from "../../lib/core/me";
import { jumpKey } from "./CommandMenu";

/** Only the screens the signed-in rep has. */
function useMine(items: NavItem[]): NavItem[] {
  const me = useMe();
  return items.filter((n) => sees(me, n.href.slice(1)));
}

/** The reads each screen makes as it mounts. A finger landing on its tab
 *  starts them, so the data is already on its way when the screen appears.
 *  Server-rendered screens (Clients, Prospect, Reports, Outbound) are not
 *  here: their data rides in the page itself. */
const MOUNT_READS: Record<string, string[]> = {
  "/route": ["/api/route/state", "/api/route/map", "/api/route/returns"],
  "/expenses": ["/api/expenses/summary"],
  "/search": ["/api/search/book"],
  "/plan": ["/api/planner/propose"],
};

const warm = (href: string) => () => MOUNT_READS[href]?.forEach(warmJson);

/** Every screen's shell fetched once the phone is idle after launch, so the
 *  first tap on any of them, the ones behind More included, paints at once.
 *  A link off screen is never prefetched by Next on its own. Router prefetch
 *  only: no data read leaves for the database (AGENTS.md P9). */
function usePrefetchAll(items: NavItem[]) {
  const router = useRouter();
  const key = items.map((n) => n.href).join(" ");
  useEffect(() => {
    const run = () => key.split(" ").forEach((href) => href && router.prefetch(href));
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 2500 });
      return () => window.cancelIdleCallback(id);
    }
    const t = window.setTimeout(run, 1200);
    return () => window.clearTimeout(t);
  }, [key, router]);
}

/** The spring Hunter's glass pill rides: a quick start, a little overshoot,
 *  a soft landing. */
const GLIDE = "cubic-bezier(.32,1.28,.42,1)";

export type NavItem = {
  href: string;
  label: string;
  icon: string;
  /** True for the destinations a rep switches between all day; those get a
   *  phone tab of their own. The rest sit behind the More tab. */
  tab?: boolean;
};

function isActive(pathname: string | null, href: string): boolean {
  return pathname === href || (pathname?.startsWith(`${href}/`) ?? false);
}

/** The desktop sidebar list. One array (NAV in layout.tsx) feeds both this
 *  and TabBar below, so adding a port's route is a single edit. */
export function SidebarNav({ items: all }: { items: NavItem[] }) {
  const pathname = usePathname();
  const items = useMine(all);
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((n, i) => {
        const active = isActive(pathname, n.href);
        const key = jumpKey(i);
        return (
          <Link
            key={n.href}
            href={n.href}
            onPointerDown={warm(n.href)}
            aria-current={active ? "page" : undefined}
            className={`group flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 text-[15px] transition-colors ${
              active ? "bg-[#ECEAE1] font-medium text-[#14201B]" : "text-[#3D4A44] hover:bg-[#ECEAE1] hover:text-[#14201B]"
            }`}
          >
            <Ico name={n.icon} />
            {n.label}
            {key && <span className="kbd ml-auto opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">G {key}</span>}
          </Link>
        );
      })}
    </nav>
  );
}

const tabCls = (active: boolean) =>
  `relative z-[1] flex min-h-11 flex-1 flex-col items-center justify-center gap-1 rounded-[22px] py-2 text-[11px] [-webkit-tap-highlight-color:transparent] transition-[color,transform] duration-300 [transition-timing-function:cubic-bezier(.23,1,.32,1)] active:scale-[0.94] active:duration-150 motion-reduce:transition-none motion-reduce:active:scale-100 ${
    active ? "font-semibold text-[#14201B]" : "text-[#3D4A44]"
  }`;

/**
 * The mobile bottom bar. Five slots at most, the iOS ceiling for a tab bar
 * at 44px targets: the four `tab: true` items, then More, which lifts a
 * glass card holding everything else.
 *
 * One glass pill marks the current slot and glides to the next on a spring,
 * the way Hunter's bar does. It moves on the tap, before the screen arrives, so the bar answers the touch rather than the network. The
 * More card grows out of the More button and shrinks back into it. Reduced
 * motion drops the glide and the grow to a plain swap.
 */
export function TabBar({ items: all }: { items: NavItem[] }) {
  const pathname = usePathname();
  const items = useMine(all);
  usePrefetchAll(items);
  const [moreOpen, setMoreOpen] = useState(false);
  // The tab a finger just chose, ahead of the route catching up.
  const [chosen, setChosen] = useState<string | null>(null);
  const tabs = items.filter((n) => n.tab);
  const rest = items.filter((n) => !n.tab);

  // Close the card and drop the early choice when the route changes,
  // adjusted during render so the new screen never paints with the card up.
  const [sheetPath, setSheetPath] = useState(pathname);
  if (sheetPath !== pathname) {
    setSheetPath(pathname);
    setMoreOpen(false);
    setChosen(null);
  }

  const here = (href: string) => (chosen ? chosen === href : isActive(pathname, href));
  const restActive = chosen ? rest.some((n) => n.href === chosen) : rest.some((n) => isActive(pathname, n.href));
  const slot = moreOpen || restActive ? "more" : (tabs.find((n) => here(n.href))?.href ?? null);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMoreOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  // Measure the pill onto its slot. The first placement lands without a
  // glide; every later one glides.
  const bar = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number; h: number; y: number; glide: boolean } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const el = slot ? bar.current?.querySelector<HTMLElement>(`[data-slot="${slot}"]`) : null;
      setPill((p) =>
        el ? { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, glide: p !== null } : null,
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [slot, items.length]);

  // The finger landing starts the screen's reads; the tap itself moves the
  // pill, so a touch that turns into a scroll never moves it.
  const choose = (href: string) => () => {
    if (!isActive(pathname, href)) setChosen(href);
  };

  // Swipe-to-dismiss for the More card: it follows a finger pulled down and
  // closes past 60px or on a flick. Reduced motion closes without the follow.
  const card = useRef<HTMLDivElement>(null);
  const pull = useRef<{ id: number; y0: number; t0: number; dy: number; on: boolean } | null>(null);
  const onPullDown = (e: React.PointerEvent) => {
    pull.current = { id: e.pointerId, y0: e.clientY, t0: e.timeStamp, dy: 0, on: false };
  };
  const onPullMove = (e: React.PointerEvent) => {
    const p = pull.current;
    if (!p || p.id !== e.pointerId) return;
    const dy = e.clientY - p.y0;
    if (!p.on) {
      if (dy < 8) return;
      p.on = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    p.dy = Math.max(0, dy);
    if (card.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      card.current.style.transition = "none";
      card.current.style.transform = `translate3d(0,${p.dy}px,0)`;
      card.current.style.opacity = String(Math.max(0.3, 1 - p.dy / 240));
    }
  };
  const onPullUp = (e: React.PointerEvent) => {
    const p = pull.current;
    pull.current = null;
    if (!p || !p.on || p.id !== e.pointerId) return;
    const v = (p.dy / Math.max(1, e.timeStamp - p.t0)) * 1000;
    if (card.current) {
      card.current.style.transition = "";
      card.current.style.transform = "";
      card.current.style.opacity = "";
    }
    if (e.type !== "pointercancel" && (p.dy > 60 || v > 600)) setMoreOpen(false);
  };

  if (items.length < 2) return null;

  return (
    <>
      <div
        aria-hidden={!moreOpen}
        onClick={() => setMoreOpen(false)}
        className={`fixed inset-0 z-30 bg-[#14201B]/15 transition-opacity duration-200 ease-out motion-reduce:transition-none md:hidden ${
          moreOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        ref={card}
        onPointerDown={onPullDown}
        onPointerMove={onPullMove}
        onPointerUp={onPullUp}
        onPointerCancel={onPullUp}
        role="dialog"
        aria-modal="true"
        aria-label="More screens"
        aria-hidden={!moreOpen}
        style={{ transitionTimingFunction: "cubic-bezier(.23,1,.32,1)" }}
        className={`glass-bar fixed right-4 z-40 min-w-[236px] touch-pan-x origin-bottom-right rounded-[22px] p-1.5 transition-[transform,opacity] duration-200 motion-reduce:transition-none md:hidden [bottom:calc(5.25rem+env(safe-area-inset-bottom))] ${
          moreOpen ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none translate-y-2 scale-[0.94] opacity-0"
        }`}
      >
        <nav className="flex flex-col">
          {rest.map((n) => {
            const active = here(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                onPointerDown={warm(n.href)}
                onClick={choose(n.href)}
                tabIndex={moreOpen ? 0 : -1}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-12 items-center gap-3 rounded-2xl px-3.5 text-[16px] [-webkit-tap-highlight-color:transparent] transition-[background-color,transform] duration-150 active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 ${
                  active ? "bg-[#14201B]/[0.07] font-medium text-[#14201B]" : "text-[#3D4A44]"
                }`}
              >
                <Ico name={n.icon} size={19} />
                {n.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <nav
        ref={bar}
        className="glass-bar fixed inset-x-3 z-40 flex gap-1 rounded-[28px] p-1.5 md:hidden [bottom:calc(0.5rem+env(safe-area-inset-bottom))]"
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 z-0 rounded-[22px] motion-reduce:transition-none"
          style={{
            width: pill?.w ?? 0,
            height: pill?.h ?? 0,
            transform: `translate3d(${pill?.x ?? 0}px, ${pill?.y ?? 0}px, 0)`,
            opacity: pill ? 1 : 0,
            background: "linear-gradient(180deg, rgba(255,255,255,.95), rgba(255,255,255,.72))",
            boxShadow:
              "inset 0 1px 0 #fff, inset 0 -1px 1px rgba(0,0,0,.03), 0 1px 2px rgba(20,32,27,.06), 0 4px 14px rgba(20,32,27,.08)",
            transition: pill?.glide
              ? `transform 520ms ${GLIDE}, width 520ms ${GLIDE}, height 520ms ${GLIDE}, opacity 200ms`
              : "opacity 200ms",
          }}
        />
        {tabs.map((n) => {
          const active = here(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              data-slot={n.href}
              onPointerDown={warm(n.href)}
              onClick={choose(n.href)}
              aria-current={active ? "page" : undefined}
              className={tabCls(active)}
            >
              <Ico name={n.icon} size={18} />
              {n.label}
            </Link>
          );
        })}
        {rest.length > 0 && (
          <button
            type="button"
            data-slot="more"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-haspopup="dialog"
            aria-current={restActive && !moreOpen ? "page" : undefined}
            className={tabCls(restActive || moreOpen)}
          >
            <Ico name="more" size={18} />
            More
          </button>
        )}
      </nav>
    </>
  );
}
