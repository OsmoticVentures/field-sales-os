import { hasAccess } from "../../lib/core/devices";
import { SidebarNav, TabBar, type NavItem } from "./Nav";

/**
 * The shared shell for every signed-in screen: the PIN gate check, then chrome.
 *
 * ONE NAV ITEM TODAY, BUILT TO GROW. Each future port (Search Map, Route
 * Planner, Visit Logger, Prospecting, Reports, Fuel Routing) adds its folder
 * under this same `(app)` route group and one line to NAV below; nothing
 * else in this file needs to change. See PORTING.md. The bottom tab bar
 * (Nav.tsx) hides itself while NAV has fewer than two items.
 */
const NAV: NavItem[] = [
  { href: "/expenses", label: "Expenses", icon: "clock" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // The layout must not be the gate: it renders the unauthenticated view
  // bare (no nav) rather than redirecting, so proxy (which already handles
  // the redirect) never loops against this component.
  if (!(await hasAccess())) {
    return <div className="min-h-screen bg-[#F7F6F1] text-[#14201B]">{children}</div>;
  }

  const hasTabBar = NAV.length > 1;

  return (
    <div className="min-h-screen bg-[#F7F6F1] text-[#14201B]">
      <div className="mx-auto flex min-h-screen max-w-[1100px] gap-0">
        <aside className="hidden w-[200px] shrink-0 border-r border-[#E2DFD5] px-5 py-7 md:block">
          <div className="mb-8">
            <div className="text-[17px] leading-none font-semibold tracking-tight">Field Sales OS</div>
          </div>
          <SidebarNav items={NAV} />
        </aside>

        {/* pb clears the mobile tab bar below md, once it exists; matches
            the aside breakpoint above. */}
        <main
          className={`min-w-0 flex-1 px-5 py-7 md:px-9 md:pb-7 ${
            hasTabBar
              ? "pb-24 [padding-bottom:calc(6rem+env(safe-area-inset-bottom))]"
              : "pb-7 [padding-bottom:calc(1.75rem+env(safe-area-inset-bottom))] md:[padding-bottom:1.75rem]"
          }`}
        >
          {children}
        </main>
      </div>

      <TabBar items={NAV} />
    </div>
  );
}
