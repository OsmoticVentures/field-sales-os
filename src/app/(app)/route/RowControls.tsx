"use client";

/**
 * The stop row's own icons and its move-to-day picker, ported from the
 * NutriBiotic OS (lib/ui.tsx ICONS, map/DayMoveMenu.tsx). Kept in the Route
 * folder rather than lib/core/ui.tsx because only this screen draws them.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { dayLabel } from "@/lib/features/route/field-week";

const PATHS: Record<string, ReactNode> = {
  grip: (
    <>
      <circle cx="6" cy="4.5" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="10" cy="4.5" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="6" cy="8" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="6" cy="11.5" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="10" cy="11.5" r="1.05" fill="currentColor" stroke="none" />
    </>
  ),
  "chevrons-up": (
    <>
      <path d="m4 8 4-4 4 4" />
      <path d="m4 12 4-4 4 4" />
    </>
  ),
  "chevrons-right": (
    <>
      <path d="m4 4 4 4-4 4" />
      <path d="m8 4 4 4-4 4" />
    </>
  ),
  locate: (
    <>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M8 1.6v2.5M8 11.9v2.5M1.6 8h2.5M11.9 8h2.5" />
    </>
  ),
  flag: (
    <>
      <path d="M3.8 14.2V2.2" />
      <path d="M3.8 2.8h8.4l-1.9 2.8 1.9 2.8H3.8" />
    </>
  ),
};

export function RowIco({ name, size = 14 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {PATHS[name]}
    </svg>
  );
}

/** Portal-rendered so the route card's overflow-hidden never clips it. */
export function DayMoveMenu({
  days,
  active,
  onPick,
  label,
  className,
}: {
  days: string[];
  active: string;
  onPick: (day: string) => void;
  label: string;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    function place() {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      setMenuPos({ top: r.bottom + 4, left: r.right - 176 });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    function onOutside(e: MouseEvent | TouchEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        className={className}
      >
        <RowIco name="chevrons-right" />
      </button>
      {menuPos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: menuPos.top, left: Math.max(8, menuPos.left) }}
            role="listbox"
            aria-label="Move to day"
            className="fixed z-50 max-h-72 w-44 overflow-auto rounded-md border border-[#E2DFD5] bg-white py-1 shadow-lg"
          >
            {days.map((day) => {
              const { weekday, short } = dayLabel(day);
              const isActive = day === active;
              return (
                <button
                  key={day}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  disabled={isActive}
                  onClick={() => {
                    setOpen(false);
                    if (!isActive) onPick(day);
                  }}
                  className={`flex min-h-11 w-full items-center justify-between gap-2 px-3 text-left text-[13px] ${
                    isActive ? "cursor-default text-[#A9AFA9]" : "text-[#14201B] hover:bg-[#FAF9F5]"
                  }`}
                >
                  <span>{weekday}</span>
                  <span className="tabular-nums text-[#8A928C]">{short}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
