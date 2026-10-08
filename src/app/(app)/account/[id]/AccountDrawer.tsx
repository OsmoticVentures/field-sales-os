"use client";

/**
 * The client, opened from inside the app: a dark side panel on the left, with
 * the whole screen (sidebar, tab bar and all) pushed right, scaled back and
 * rounded, peeking at the edge. One progress value drives every frame: the
 * screen's travel, scale, corners and shadow, and the panel's parallax and
 * fade. It is a spring with the finger's velocity handed through, so a grab
 * mid-flight catches it and a flick throws it.
 *
 * Close: tap the peeking screen, drag it (or the panel) left, or Escape. The
 * route only goes back once the spring lands. A tile that opens another
 * screen plays the same close first, then replaces the client's history entry. "View account" opens the full view over
 * the panel (AccountSheet), and its back returns here.
 *
 * The screen scrolls on the window, so opening locks the shell to the
 * viewport and shifts its content up by the scroll it left at; closing
 * undoes that and puts the window back at exactly that position.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { sees, useMe } from "../../../../lib/core/me";
import { getAccountPayload, onAccountPayload, peekAccountPayload, readStoredAccount } from "../../../../lib/core/phone-sync";
import { holdScroll, restoreScroll, savedScrollY } from "../../../../lib/core/scroll-keeper";
import { project, rubberband, runFade, runSpring } from "../../../../lib/core/spring";
import { Ico, displayFace } from "../../../../lib/core/ui";
import type { AccountPayload } from "../../../../lib/features/clients/account-payload";
import { absoluteUrl, outlookCompose } from "../../../../lib/features/clients/ui";
import { HUBSPOT_COMPANY_URL } from "../../../../lib/features/prospect/format";
import { AccountClient } from "./AccountClient";
import { AccountSheet } from "./AccountSheet";
import { useDraftOutreach } from "./AccountView";

const PEEK = 68; // px of the screen left showing on a phone
const PANEL_W = 380; // panel width from md up, and how far the screen travels
const PARALLAX = 24; // px the panel content starts left of rest
const RADIUS = 28; // px of screen corner at rest
const TAP_SLOP = 8; // px a finger may wander and still be a tap
const COMMIT_SHARE = 0.5; // projected share of the travel that keeps it open

type Geometry = { travel: number; scale: number };

function geometry(): Geometry {
  const wide = window.matchMedia("(min-width: 768px)").matches;
  return wide ? { travel: PANEL_W, scale: 0.95 } : { travel: Math.max(0, window.innerWidth - PEEK), scale: 0.9 };
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const subscribeReduced = (notify: () => void) => {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", notify);
  return () => mq.removeEventListener("change", notify);
};

/** Up to two initials, taken only from the name itself. */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => Array.from(w)[0].toUpperCase())
    .join("");
}

type LoadFail = "offline" | "missing";

/** The client's payload from the phone's copy, falling back to one fetch. */
function useAccountPayload(id: string): { payload: AccountPayload | null; fail: LoadFail | null } {
  const [payload, setPayload] = useState<AccountPayload | null>(() => peekAccountPayload(id) ?? null);
  const [fail, setFail] = useState<LoadFail | null>(null);
  useEffect(() => {
    let alive = true;
    const off = onAccountPayload(id, (p) => alive && setPayload(p));
    if (!peekAccountPayload(id)) {
      void (async () => {
        const stored = await readStoredAccount(id);
        if (!alive) return;
        if (stored) return setPayload(stored);
        const r = await getAccountPayload(id);
        if (!alive) return;
        if ("payload" in r) setPayload(r.payload);
        else setFail("missing" in r ? "missing" : "offline");
      })();
    }
    return () => {
      alive = false;
      off();
    };
  }, [id]);
  return { payload, fail };
}

const tileCls =
  "flex min-h-[96px] flex-col items-start justify-between rounded-[22px] bg-[#F7F6F1]/[0.08] p-4 text-left text-[16px] leading-[1.2] text-[#F7F6F1] transition-[transform,background-color] duration-100 [@media(hover:hover)]:hover:bg-[#F7F6F1]/[0.11] active:scale-[0.97] active:bg-[#F7F6F1]/[0.14] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#F7F6F1]/60";
const tileIcon = "text-[#F7F6F1]/60";

/** A tile that opens another screen: the panel closes first, then the route
 *  replaces the client's entry, so Back returns to the list. */
function LeaveLink({
  href,
  leave,
  className,
  children,
}: {
  href: string;
  leave: (href: string) => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        leave(href);
      }}
    >
      {children}
    </Link>
  );
}

function DraftTile({ accountId, leave }: { accountId: string; leave: (href: string) => void }) {
  const { busy, result, error, run } = useDraftOutreach(accountId);
  if (result?.status === "drafted" || result?.status === "already_queued") {
    return (
      <LeaveLink href={`/outbound?account=${accountId}`} leave={leave} className={tileCls}>
        <span className={tileIcon}>
          <Ico name="check" size={24} />
        </span>
        {result.status === "already_queued" ? "Queued in Outbound" : "Drafted in Outbound"}
      </LeaveLink>
    );
  }
  const reason = (result?.status === "not_written" && result.reason) || error;
  return (
    <button type="button" onClick={run} disabled={busy} className={`${tileCls} disabled:opacity-60`}>
      <span className={tileIcon}>
        <Ico name="send" size={24} />
      </span>
      <span>
        {busy ? "Drafting" : "Draft outreach"}
        {reason ? <span className="mt-1.5 block text-[13px] leading-snug text-[#E58A82]">{reason}</span> : null}
      </span>
    </button>
  );
}

export function AccountDrawer({ id }: { id: string }) {
  const router = useRouter();
  const me = useMe();
  const { payload, fail } = useAccountPayload(id);
  const a = payload?.account;

  const reduced = useSyncExternalStore(subscribeReduced, reducedMotion, () => false);
  const [full, setFull] = useState(false);

  const dialog = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const hit = useRef<HTMLDivElement>(null);
  const viewRow = useRef<HTMLButtonElement>(null);

  const geo = useRef<Geometry>({ travel: PANEL_W, scale: 0.95 });
  const reducedRef = useRef(false);
  const shellRef = useRef<HTMLElement | null>(null);
  const px = useRef(0); // live travel in px, 0 closed, geo.travel open
  const stop = useRef<(() => void) | null>(null);
  const closing = useRef(false);
  const leaving = useRef(false);
  const settled = useRef(false);
  const fullRef = useRef(false);
  const drag = useRef<{
    id: number;
    startClientX: number;
    startClientY: number;
    startPx: number;
    caught: boolean;
    wasClosing: boolean;
    fromPanel: boolean;
    moved: boolean;
    cancelled: boolean;
    samples: { t: number; x: number }[];
  } | null>(null);

  // Every frame, from the one number.
  const paint = useCallback((value: number) => {
    px.current = value;
    const { travel, scale } = geo.current;
    const p = travel ? Math.min(1, Math.max(0, value / travel)) : 0;
    const shell = shellRef.current;
    if (reducedRef.current) {
      // Nothing travels: the panel fades in over a dimmed screen.
      if (dialog.current) dialog.current.style.opacity = String(p);
      if (hit.current) hit.current.style.opacity = String(p);
      return;
    }
    const s = 1 - (1 - scale) * p;
    // A hard flick can carry the spring past 0; the screen never goes left of home.
    const frame = `translate3d(${Math.max(0, value)}px,0,0) scale(${s})`;
    if (shell) {
      shell.style.transform = frame;
      shell.style.borderRadius = `${RADIUS * p}px`;
      shell.style.boxShadow = `-14px 0 44px rgba(0,0,0,${0.5 * p})`;
    }
    if (hit.current) {
      hit.current.style.transform = frame;
      hit.current.style.borderRadius = `${RADIUS * p}px`;
    }
    if (content.current) {
      content.current.style.transform = `translate3d(${-PARALLAX * (1 - p)}px,0,0)`;
      content.current.style.opacity = String(Math.min(1, p * 1.25));
    }
  }, []);

  const run = useCallback(
    (target: number, velocity: number, done?: () => void, stopAtTarget = false) => {
      stop.current?.();
      const onDone = () => {
        paint(target);
        done?.();
      };
      stop.current = reducedRef.current
        ? runFade({ from: px.current, to: target, onFrame: paint, onDone })
        : runSpring({ from: px.current, to: target, velocity, stopAtTarget, onFrame: paint, onDone });
    },
    [paint],
  );

  // Lock the shell to the viewport, shifted up by the scroll it left at.
  // Returns the undo, which puts the window back at exactly that scroll.
  const lock = useCallback(() => {
    const shell = document.getElementById("app-shell");
    const inner = shell?.firstElementChild as HTMLElement | null;
    if (!shell || !inner) return () => {};
    const y = savedScrollY();
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    shellRef.current = shell;
    // Keep the window as tall as it was, so it holds its scroll and its bar.
    document.body.style.minHeight = `${document.documentElement.scrollHeight}px`;
    Object.assign(shell.style, {
      position: "fixed",
      inset: "0",
      minHeight: "0",
      overflow: "hidden",
      zIndex: "41",
      transformOrigin: "0 50%",
      willChange: "transform",
    });
    inner.style.marginTop = `${-y}px`;
    shell.setAttribute("inert", "");
    // The window sits still under the fixed shell: no chaining, no rubber-band.
    const root = document.documentElement;
    root.style.overscrollBehavior = "none";
    return () => {
      root.style.overscrollBehavior = "";
      shell.removeAttribute("inert");
      shell.removeAttribute("style");
      inner.style.marginTop = "";
      document.body.style.minHeight = "";
      restoreScroll(y);
      shellRef.current = null;
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true });
    };
  }, []);

  const finish = useCallback(() => {
    if (settled.current) return;
    settled.current = true;
    router.back();
  }, [router]);

  const close = useCallback(
    (velocity = 0) => {
      if (closing.current || settled.current) return;
      closing.current = true;
      run(
        0,
        velocity,
        () => {
          if (closing.current) finish();
        },
        true,
      );
    },
    [run, finish],
  );

  // Another screen from a tile: play the close, then replace this entry.
  const leave = useCallback(
    (href: string) => {
      if (closing.current || settled.current) return;
      closing.current = true;
      leaving.current = true;
      run(
        0,
        0,
        () => {
          settled.current = true;
          router.replace(href);
        },
        true,
      );
    },
    [run, router],
  );

  useLayoutEffect(() => {
    const isReduced = reducedMotion();
    reducedRef.current = isReduced;
    geo.current = geometry();
    // Freeze the remembered scroll first, in the same commit: Next resets the
    // window to the top as the route changes, and that must not be remembered.
    const release = holdScroll();
    const unlock = lock();
    closing.current = false;
    settled.current = false;
    px.current = 0;
    paint(0);
    run(geo.current.travel, 0);
    dialog.current?.focus({ preventScroll: true });

    const onResize = () => {
      geo.current = geometry();
      if (!closing.current) paint(px.current > 0 ? geo.current.travel : 0);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      stop.current?.();
      unlock();
      release();
    };
  }, [lock, paint, run]);

  useEffect(() => {
    fullRef.current = full;
  }, [full]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !fullRef.current) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  // The peeking screen is the close target and the thing you drag; on a
  // touch screen the panel's own horizontal swipe drags it too.
  const press = (on: boolean) => {
    if (hit.current) hit.current.style.backgroundColor = on ? (reducedRef.current ? "rgba(20,32,27,0.62)" : "rgba(20,32,27,0.1)") : "";
  };
  const begin = (e: React.PointerEvent, fromPanel: boolean) => {
    if (leaving.current) return;
    if (fromPanel && e.pointerType === "mouse") return;
    const caught = px.current > 0.5 && px.current < geo.current.travel - 0.5;
    const wasClosing = closing.current;
    if (!fromPanel) {
      e.currentTarget.setPointerCapture(e.pointerId);
      stop.current?.();
      closing.current = false; // a grab during a close takes it back
      press(true); // the press registers at once, before any release
    }
    drag.current = {
      id: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPx: px.current,
      caught,
      wasClosing,
      fromPanel,
      moved: false,
      cancelled: false,
      samples: [{ t: e.timeStamp, x: e.clientX }],
    };
  };
  const onDown = (e: React.PointerEvent) => begin(e, false);
  const onPanelDown = (e: React.PointerEvent) => begin(e, true);
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || d.cancelled) return;
    d.samples.push({ t: e.timeStamp, x: e.clientX });
    if (d.samples.length > 6) d.samples.shift();
    const dx = e.clientX - d.startClientX;
    const dy = e.clientY - d.startClientY;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < TAP_SLOP) return;
      // A mostly vertical move is not ours: neither a tap nor a drag.
      // On the panel it stays a scroll, and only a leftward swipe is ours.
      if (Math.abs(dy) > Math.abs(dx) || (d.fromPanel && dx > 0)) {
        d.cancelled = true;
        press(false);
        return;
      }
      d.moved = true;
      press(false);
      if (d.fromPanel) {
        // Taking hold only now keeps a plain tap on a tile a plain tap.
        e.currentTarget.setPointerCapture(e.pointerId);
        d.wasClosing = closing.current;
        stop.current?.();
        closing.current = false;
        d.startPx = px.current;
      }
    }
    if (reducedRef.current) return;
    const { travel } = geo.current;
    const raw = d.startPx + dx;
    paint(raw > travel ? travel + rubberband(raw - travel, travel) : Math.max(0, raw));
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    press(false);
    const { travel } = geo.current;
    if (d.fromPanel && !d.moved) return; // a tap or a scroll, not ours
    if (e.type === "pointercancel" || d.cancelled) {
      // Put back whatever the grab interrupted.
      if (d.wasClosing) return close();
      if (d.caught || d.moved || (e.type === "pointercancel" && !d.fromPanel)) return run(travel, 0);
      return;
    }
    if (!d.moved) {
      // A tap closes. One that lands during a close keeps closing; one that
      // only caught the screen opening lets it finish opening.
      return d.wasClosing ? close() : d.caught ? run(travel, 0) : close();
    }
    if (reducedRef.current) return close();
    // Velocity from the last 100ms only: a finger that paused has stopped.
    const recent = d.samples.filter((s) => e.timeStamp - s.t < 100);
    const first = recent[0];
    const last = recent[recent.length - 1];
    const v = first && last.t > first.t ? ((last.x - first.x) / (last.t - first.t)) * 1000 : 0;
    const lands = px.current + project(v);
    if (lands < travel * COMMIT_SHARE) close(v);
    else run(travel, v);
  };

  const name = a?.name ?? "";
  const initials = initialsOf(name);
  const tiles: React.ReactNode[] = [];
  if (a?.phone) {
    tiles.push(
      <a key="call" href={`tel:${a.phone}`} className={tileCls}>
        <span className={tileIcon}>
          <Ico name="phone" size={24} />
        </span>
        Call
      </a>,
    );
  }
  if (a) {
    tiles.push(
      <LeaveLink key="visit" href={`/visit?${new URLSearchParams({ account: a.id, name: a.name })}`} leave={leave} className={tileCls}>
        <span className={tileIcon}>
          <Ico name="edit" size={24} />
        </span>
        Log a visit
      </LeaveLink>,
    );
  }
  if (a?.website) {
    tiles.push(
      <a key="site" href={absoluteUrl(a.website)} target="_blank" rel="noreferrer" className={tileCls}>
        <span className={tileIcon}>
          <Ico name="globe" size={24} />
        </span>
        Website
      </a>,
    );
  }
  if (a?.email) {
    tiles.push(
      <a key="email" href={outlookCompose(a.email)} target="_blank" rel="noreferrer" className={tileCls}>
        <span className={tileIcon}>
          <Ico name="mail" size={24} />
        </span>
        Email
      </a>,
    );
  }
  if (a?.hubspot_company_id) {
    tiles.push(
      <a key="hubspot" href={HUBSPOT_COMPANY_URL(a.hubspot_company_id)} target="_blank" rel="noopener noreferrer" className={tileCls}>
        <span className={tileIcon}>
          <Ico name="hubspot" size={24} />
        </span>
        HubSpot
      </a>,
    );
  }
  if (a && sees(me, "outbound")) tiles.push(<DraftTile key="draft" accountId={a.id} leave={leave} />);

  const failText = fail === "missing" ? "Client not found." : fail === "offline" ? "No connection." : null;

  return (
    <>
      {/* Behind the screen: what shows around it as it shrinks. */}
      {!reduced && <div aria-hidden className="fixed inset-0 z-40 bg-[#14201B]" />}

      {/* One dialog around the panel and the peeking screen, so the screen's
          Close button is inside it for assistive tech. No box of its own. */}
      <div role="dialog" aria-modal="true" aria-label={name || "Client"} inert={full}>
        <div
          ref={dialog}
          tabIndex={-1}
          onPointerDown={onPanelDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className={`fixed inset-y-0 left-0 w-[calc(100%-68px)] touch-pan-y overflow-y-auto overscroll-none text-[#F7F6F1] outline-none md:w-[380px] ${
            reduced ? "z-[43] bg-[#14201B] opacity-0 shadow-[12px_0_40px_rgba(0,0,0,0.35)]" : "z-40"
          }`}
        >
          <div
            ref={content}
            style={{ opacity: reduced ? 1 : 0 }}
            className="flex min-h-full flex-col px-5 pb-8 [padding-bottom:calc(2rem+env(safe-area-inset-bottom))] [padding-left:max(1.25rem,env(safe-area-inset-left))] [padding-top:calc(1.25rem+env(safe-area-inset-top))] md:px-6"
          >
            {initials && (
              <div className="flex size-14 items-center justify-center rounded-2xl border border-[#F7F6F1]/10 bg-[#F7F6F1]/[0.04] text-[19px] font-semibold tracking-[0.02em] text-[#F7F6F1]/80">
                {initials}
              </div>
            )}
            {name && (
              <h2
                className={`${displayFace} mt-5 text-[34px] leading-[1.05] font-medium tracking-[-0.02em] [overflow-wrap:anywhere] text-[#F7F6F1]`}
              >
                {name}
              </h2>
            )}
            <button
              ref={viewRow}
              type="button"
              onClick={() => setFull(true)}
              className={`-ml-2 mt-3 flex min-h-11 w-fit items-center gap-1.5 rounded-xl px-2 text-[17px] text-[#F7F6F1]/60 transition-[transform,color] active:scale-[0.97] active:text-[#F7F6F1] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#F7F6F1]/60 ${
                failText ? "mb-2" : "mb-7"
              }`}
            >
              View account
              <Ico name="chevron-right" size={16} />
            </button>
            {failText && <p className="mb-7 text-[15px] text-[#E58A82]">{failText}</p>}
            {tiles.length > 0 && <div className="grid grid-cols-2 gap-3">{tiles}</div>}
          </div>
        </div>

        {/* The screen's own rectangle, above it: a tap here closes, a drag
            moves it, and nothing inside the screen can be pressed. */}
        <div
          ref={hit}
          role="button"
          tabIndex={0}
          aria-label="Close"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              close();
            }
          }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          style={{ touchAction: "none", transformOrigin: "0 50%", ...(reduced ? { opacity: 0 } : null) }}
          className={`fixed inset-0 z-[42] cursor-pointer outline-none focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-[#F7F6F1]/70 ${
            reduced ? "bg-[#14201B]/50" : "[@media(hover:hover)]:hover:bg-[#14201B]/[0.05] will-change-transform"
          }`}
        />
      </div>

      {full && (
        <AccountSheet
          onClose={() => {
            setFull(false);
            requestAnimationFrame(() => viewRow.current?.focus({ preventScroll: true }));
          }}
        >
          <AccountClient key={id} id={id} />
        </AccountSheet>
      )}
    </>
  );
}
