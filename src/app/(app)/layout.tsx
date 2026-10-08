import { PhoneSync } from "../../lib/core/phone-sync-mount";
import { ScrollKeeper } from "../../lib/core/scroll-keeper";
import { UnsentStatus } from "../../lib/core/unsent";
import { SidebarNav, TabBar, type NavItem } from "./Nav";

/**
 * The shared shell for every signed-in screen: the PIN gate check, then chrome.
 *
 * ONE ARRAY FEEDS BOTH NAVS. Order is the deck's order. The desktop sidebar
 * shows all seven; the phone tab bar shows the four marked `tab` (the
 * screens a rep switches between at a stop) and folds the rest behind a
 * More tab, see Nav.tsx. A new port is one line here.
 */
const NAV: NavItem[] = [
  { href: "/visit", label: "Visit", icon: "edit", tab: true },
  { href: "/route", label: "Route", icon: "route", tab: true },
  { href: "/prospect", label: "Prospect", icon: "phone", tab: true },
  { href: "/clients", label: "Clients", icon: "book" },
  { href: "/search", label: "Search", icon: "search", tab: true },
  { href: "/expenses", label: "Expenses", icon: "clock" },
  { href: "/reports", label: "Reports", icon: "chart" },
  { href: "/fuel", label: "Fuel", icon: "fuel" },
  { href: "/outbound", label: "Outbound", icon: "mail" },
];

export default function AppLayout({ children, modal }: { children: React.ReactNode; modal: React.ReactNode }) {
  // No access check here, on purpose: one here makes every screen render
  // on demand. Proxy turns away a signed-out request before it lands; a
  // screen that renders data on the server calls requireAccess() itself;
  // every API route asks hasAccess(). The rest are static and instant.

  const hasTabBar = NAV.length > 1;

  return (
    <>
      {/* The shell the side panel pushes aside (AccountDrawer finds it by id). */}
      <div id="app-shell" className="min-h-screen bg-[#F7F6F1] text-[#14201B]">
        <div className="mx-auto flex min-h-screen max-w-[1700px] gap-0">
          <aside className="hidden w-[200px] shrink-0 border-r border-[#E2DFD5] px-5 py-7 md:block">
            <div className="mb-8">
              <div className="text-[17px] leading-none font-semibold tracking-tight">ClientOS</div>
            </div>
            <SidebarNav items={NAV} />
          </aside>

          {/* pb clears the mobile tab bar below md, once it exists; matches
              the aside breakpoint above. */}
          <main
            className={`min-w-0 flex-1 px-5 py-7 [padding-top:calc(1.75rem+env(safe-area-inset-top))] md:px-9 md:pb-7 md:[padding-top:1.75rem] ${
              hasTabBar
                ? "pb-24 [padding-bottom:calc(7rem+env(safe-area-inset-bottom))]"
                : "pb-7 [padding-bottom:calc(1.75rem+env(safe-area-inset-bottom))] md:[padding-bottom:1.75rem]"
            }`}
          >
            {children}
          </main>
        </div>

        <ScrollKeeper />
        <PhoneSync />
        <UnsentStatus />

        <TabBar items={NAV} />
      </div>
      {modal}
    </>
  );
}
