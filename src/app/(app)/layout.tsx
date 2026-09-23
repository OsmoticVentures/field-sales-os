import Link from "next/link";
import { hasAccess } from "../../lib/core/devices";
import { Ico } from "../../lib/core/ui";

/**
 * The shared shell for every signed-in screen: the PIN gate check, then chrome.
 *
 * ONE NAV ITEM TODAY, BUILT TO GROW. Each future port (Search Map, Route
 * Planner, Visit Logger, Prospecting, Reports, Fuel Routing) adds its folder
 * under this same `(app)` route group and one line to NAV below; nothing
 * else in this file needs to change. See PORTING.md.
 */
const NAV: { href: string; label: string; icon: string }[] = [
  { href: "/expenses", label: "Expenses", icon: "clock" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // The layout must not be the gate: it renders the unauthenticated view
  // bare (no nav) rather than redirecting, so proxy (which already handles
  // the redirect) never loops against this component.
  if (!(await hasAccess())) {
    return <div className="min-h-screen bg-[#F7F6F1] text-[#14201B]">{children}</div>;
  }

  return (
    <div className="min-h-screen bg-[#F7F6F1] text-[#14201B]">
      <div className="mx-auto flex min-h-screen max-w-[1100px] gap-0">
        <aside className="hidden w-[200px] shrink-0 border-r border-[#E2DFD5] px-5 py-7 md:block">
          <div className="mb-8">
            <div className="text-[17px] leading-none font-semibold tracking-tight">Field Sales OS</div>
          </div>
          <nav className="flex flex-col gap-0.5">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[14px] text-[#3D4A44] transition-colors hover:bg-[#ECEAE1] hover:text-[#14201B]"
              >
                <Ico name={n.icon} />
                {n.label}
              </Link>
            ))}
          </nav>
        </aside>

        {/* pb clears the mobile tab bar below md, matching the aside breakpoint above. */}
        <main className="min-w-0 flex-1 px-5 py-7 pb-24 [padding-bottom:calc(6rem+env(safe-area-inset-bottom))] md:px-9 md:pb-7">
          {children}
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 flex border-t border-[#E2DFD5] bg-[#FAF9F5]/95 backdrop-blur md:hidden [padding-bottom:env(safe-area-inset-bottom)]">
        {NAV.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className="flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] text-[#3D4A44]"
          >
            <Ico name={n.icon} size={18} />
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
