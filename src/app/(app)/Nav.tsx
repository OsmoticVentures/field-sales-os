"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { warmJson } from "../../lib/core/api";
import { Ico } from "../../lib/core/ui";

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
export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((n) => {
        const active = isActive(pathname, n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            onPointerDown={warm(n.href)}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 items-center gap-2.5 rounded-md px-2.5 py-2 text-[14px] transition-colors ${
              active ? "bg-[#ECEAE1] font-medium text-[#14201B]" : "text-[#3D4A44] hover:bg-[#ECEAE1] hover:text-[#14201B]"
            }`}
          >
            <Ico name={n.icon} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

const tabCls = (active: boolean) =>
  `flex min-h-11 flex-1 flex-col items-center justify-center gap-1 rounded-[22px] py-2 text-[11px] transition-[transform,background-color] active:scale-[0.95] motion-reduce:transition-none motion-reduce:active:scale-100 ${
    active ? "bg-[#14201B]/10 font-semibold text-[#14201B] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]" : "text-[#3D4A44]"
  }`;

/**
 * The mobile bottom bar. Five slots at most, the iOS ceiling for a tab bar
 * at 44px targets: the four `tab: true` items, then More, which lifts a
 * sheet holding everything else. The sheet rises from the bar that opened
 * it and leaves the same way (apple-design: enter and exit along one path,
 * anchored to the trigger), with a scrim because picking a screen is a
 * modal choice. Reduced motion collapses the slide to a fade.
 */
export function TabBar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const tabs = items.filter((n) => n.tab);
  const rest = items.filter((n) => !n.tab);
  const restActive = rest.some((n) => isActive(pathname, n.href));

  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMoreOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  if (items.length < 2) return null;

  return (
    <>
      <div
        aria-hidden={!moreOpen}
        onClick={() => setMoreOpen(false)}
        className={`fixed inset-0 z-30 bg-[#14201B]/30 transition-opacity duration-200 ease-out motion-reduce:transition-none md:hidden ${
          moreOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="More screens"
        aria-hidden={!moreOpen}
        className={`fixed inset-x-0 bottom-0 z-40 origin-bottom glass-bar rounded-t-[28px] transition-[transform,opacity] duration-250 ease-out motion-reduce:transition-opacity md:hidden [padding-bottom:calc(4.25rem+env(safe-area-inset-bottom))] ${
          moreOpen ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-full opacity-0 motion-reduce:translate-y-0"
        }`}
      >
        <div className="mx-auto mt-2 mb-1 h-1 w-9 rounded-full bg-[#D8D4C8]" />
        <nav className="flex flex-col px-2 py-1">
          {rest.map((n) => {
            const active = isActive(pathname, n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                onPointerDown={warm(n.href)}
                tabIndex={moreOpen ? 0 : -1}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-12 items-center gap-3 rounded-md px-3 text-[15px] transition-colors ${
                  active ? "bg-[#ECEAE1] font-medium text-[#14201B]" : "text-[#3D4A44]"
                }`}
              >
                <Ico name={n.icon} size={18} />
                {n.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <nav className="glass-bar fixed inset-x-3 z-40 flex gap-1 rounded-[28px] p-1.5 md:hidden [bottom:calc(0.5rem+env(safe-area-inset-bottom))]">
        {tabs.map((n) => {
          const active = isActive(pathname, n.href);
          return (
            <Link key={n.href} href={n.href} onPointerDown={warm(n.href)} aria-current={active ? "page" : undefined} className={tabCls(active)}>
              <Ico name={n.icon} size={18} />
              {n.label}
            </Link>
          );
        })}
        {rest.length > 0 && (
          <button
            type="button"
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
