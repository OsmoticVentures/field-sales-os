"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ico } from "../../lib/core/ui";

export type NavItem = { href: string; label: string; icon: string };

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

/** The mobile bottom bar. Stays hidden while there is only one destination,
 *  a tab bar with one tab is chrome with nothing to switch between; it
 *  appears on its own once a second port lands its route here. */
export function TabBar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  if (items.length < 2) return null;
  return (
    <nav className="fixed inset-x-0 bottom-0 flex border-t border-[#E2DFD5] bg-[#FAF9F5]/95 backdrop-blur md:hidden [padding-bottom:env(safe-area-inset-bottom)]">
      {items.map((n) => {
        const active = isActive(pathname, n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-1 py-2.5 text-[11px] ${
              active ? "font-medium text-[#14201B]" : "text-[#3D4A44]"
            }`}
          >
            <Ico name={n.icon} size={18} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
