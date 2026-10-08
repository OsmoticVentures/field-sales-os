"use client";

/**
 * The Clients list, phone rows and desktop table, drawn a page at a time.
 * Every row carries ten picker buttons and three inputs, twice (one layout
 * per screen size), so the whole book at once was megabytes of HTML for the
 * phone to parse and hydrate before the screen answered a tap. The first
 * rows paint with the page; the next ones are drawn as the list nears them,
 * well before they scroll into view, so the scroll never meets an end that
 * is not the real one. Same rows, same order, same cells as before.
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { MetricCell, ReadinessCell, TierCell } from "./MetricCell";

export type ClientsRow = {
  id: string;
  name: string;
  lifecycle: string | null;
  tier: string | null;
  readiness: string | null;
  shelf: number | null;
  employees: number | null;
  stores: number | null;
  /** Open-now, worked out on the server from the account's hours. */
  open: { open: boolean; label: string } | null;
};

const FIRST = 40;
const STEP = 80;

export function ClientsList({ rows }: { rows: ClientsRow[] }) {
  const [shown, setShown] = useState(FIRST);
  const phoneEnd = useRef<HTMLLIElement>(null);
  const deskEnd = useRef<HTMLTableRowElement>(null);
  const more = shown < rows.length;

  useEffect(() => {
    if (!more) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(rows.length, n + STEP));
      },
      { rootMargin: "1600px 0px" },
    );
    if (phoneEnd.current) io.observe(phoneEnd.current);
    if (deskEnd.current) io.observe(deskEnd.current);
    return () => io.disconnect();
  }, [more, shown, rows.length]);

  const page = rows.slice(0, shown);

  return (
    <>
      <ul className="divide-y divide-[#EDEBE3] overflow-hidden rounded-lg border border-[#E2DFD5] bg-white md:hidden">
        {page.map((r) => (
          <li key={r.id} className="px-4 py-3">
            <Link prefetch={false} href={`/account/${r.id}`} className="block min-h-11">
              <span className="block truncate text-[15px] font-medium">{r.name}</span>
              <span className="mt-0.5 flex items-center gap-2 text-[12.5px] text-[#8A928C]">
                {r.open && (
                  <span
                    className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${r.open.open ? "bg-[#3D6B4A]" : "bg-[#B7ACA0]"}`}
                    title={r.open.label}
                  />
                )}
                {r.lifecycle && <span>{r.lifecycle}</span>}
              </span>
            </Link>
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
              <TierCell accountId={r.id} tier={r.tier} />
              <ReadinessCell accountId={r.id} initial={r.readiness} />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-3 text-[11px] uppercase tracking-[0.08em] text-[#8A928C]">
              <label className="flex flex-col gap-1">
                Shelves
                <MetricCell accountId={r.id} field="shelf_units" initial={r.shelf} label="Shelf units (3 ft each)" />
              </label>
              <label className="flex flex-col gap-1">
                Employees
                <MetricCell accountId={r.id} field="employee_count" initial={r.employees} label="Employees on supplements and body care" />
              </label>
              <label className="flex flex-col gap-1">
                Stores
                <MetricCell accountId={r.id} field="stores_per_decision_maker" initial={r.stores} label="Stores" />
              </label>
            </div>
          </li>
        ))}
        {more && <li ref={phoneEnd} aria-hidden className="h-px" />}
      </ul>

      <div className="hidden rounded-lg border border-[#E2DFD5] bg-white md:block">
        <table className="w-full text-[13.5px]">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-[#8A928C] [&>th]:sticky [&>th]:top-0 [&>th]:z-10 [&>th]:border-b [&>th]:border-[#E2DFD5] [&>th]:bg-white">
              <th className="px-4 py-2.5 font-medium">OS tier</th>
              <th className="px-4 py-2.5 font-medium">Readiness</th>
              <th className="px-4 py-2.5 font-medium">Account</th>
              <th className="px-4 py-2.5 font-medium">State</th>
              <th className="px-4 py-2.5 text-right font-medium">Shelves</th>
              <th className="px-4 py-2.5 text-right font-medium">Employees</th>
              <th className="px-4 py-2.5 text-right font-medium">Stores</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#EDEBE3]">
            {page.map((r) => (
              <tr key={r.id} className="transition-colors hover:bg-[#FAF9F5]">
                <td className="px-4 py-2.5">
                  <TierCell accountId={r.id} tier={r.tier} />
                </td>
                <td className="px-4 py-2">
                  <ReadinessCell accountId={r.id} initial={r.readiness} />
                </td>
                <td className="px-4 py-2.5">
                  <Link prefetch={false} href={`/account/${r.id}`} className="font-medium underline-offset-2 hover:underline">
                    {r.name}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-[#5B6560]">{r.lifecycle}</td>
                <td className="px-4 py-2 text-right">
                  <MetricCell accountId={r.id} field="shelf_units" initial={r.shelf} label="Shelf units (3 ft each)" />
                </td>
                <td className="px-4 py-2 text-right">
                  <MetricCell accountId={r.id} field="employee_count" initial={r.employees} label="Employees on supplements and body care" />
                </td>
                <td className="px-4 py-2 text-right">
                  <MetricCell accountId={r.id} field="stores_per_decision_maker" initial={r.stores} label="Stores" />
                </td>
              </tr>
            ))}
            {more && (
              <tr ref={deskEnd} aria-hidden>
                <td colSpan={7} className="h-px p-0" />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
