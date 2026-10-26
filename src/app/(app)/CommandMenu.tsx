"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { sees, useMe } from "../../lib/core/me";
import { all } from "../../lib/core/phone-store";
import { Ico, inputCls } from "../../lib/core/ui";
import type { NavItem } from "./Nav";

/**
 * Command menu (Cmd+K or Ctrl+K), for a keyboard at desktop width. Lists every
 * screen and every client on the phone's copy of the book; Enter opens the
 * highlighted row. "G" then a number jumps to that screen from anywhere, the
 * same key the sidebar and this list show beside it. Reads only the on-device
 * store, so it adds no server read.
 */

type Row = { id: string; label: string; hint?: string; icon: string; href: string };

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/** The jump key for the nth screen in the sidebar: 1 to 9, then 0. */
export const jumpKey = (i: number): string | null => (i < 9 ? String(i + 1) : i === 9 ? "0" : null);

export function CommandKeys({ items }: { items: NavItem[] }) {
  const router = useRouter();
  const me = useMe();
  const mine = useMemo(() => items.filter((n) => sees(me, n.href.slice(1))), [items, me]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let armed = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return;
      if (e.key.toLowerCase() === "g") {
        armed = Date.now();
        return;
      }
      if (armed && Date.now() - armed < 1200) {
        armed = 0;
        const i = mine.findIndex((_, idx) => jumpKey(idx) === e.key);
        if (i >= 0) router.push(mine[i].href);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("nb:command-menu", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("nb:command-menu", onOpen);
    };
  }, [mine, router]);

  return open ? <Menu screens={mine} onClose={() => setOpen(false)} /> : null;
}

/** The sidebar's way in for a pointer. */
export function CommandButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event("nb:command-menu"))}
      className="mt-4 flex min-h-11 w-full items-center gap-2.5 rounded-md border border-[#E2DFD5] px-2.5 text-[14px] text-[#5B6560] transition-colors hover:bg-[#ECEAE1] hover:text-[#14201B]"
    >
      <Ico name="search" />
      Jump to
      <span className="kbd ml-auto">⌘K</span>
    </button>
  );
}

function Menu({ screens, onClose }: { screens: NavItem[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [clients, setClients] = useState<Row[]>([]);
  const [at, setAt] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    let live = true;
    void all<{ account?: { id: string; name: string; city?: string | null } }>("snap").then((rows) => {
      if (!live) return;
      setClients(
        rows
          .filter((r) => r.key.startsWith("acct:") && r.value?.account?.name)
          .map((r) => ({
            id: r.key,
            label: r.value.account!.name,
            hint: r.value.account!.city ?? undefined,
            icon: "book",
            href: `/account/${r.value.account!.id}`,
          })),
      );
    });
    return () => {
      live = false;
    };
  }, []);

  const rows: Row[] = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const nav: Row[] = screens.map((n, i) => ({ id: n.href, label: n.label, hint: jumpKey(i) ? `G ${jumpKey(i)}` : undefined, icon: n.icon, href: n.href }));
    if (!needle) return nav;
    return [
      ...nav.filter((r) => r.label.toLowerCase().includes(needle)),
      ...clients.filter((r) => r.label.toLowerCase().includes(needle)).slice(0, 8),
    ];
  }, [q, screens, clients]);

  const go = (r: Row | undefined) => {
    if (!r) return;
    onClose();
    router.push(r.href);
  };

  useEffect(() => {
    list.current?.querySelector(`[data-i="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  return (
    <div className="fixed inset-0 z-[60] hidden items-start justify-center bg-[#14201B]/25 pt-[14vh] md:flex" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        className="glass-bar w-[min(560px,92vw)] overflow-hidden rounded-[22px] p-2"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt((i) => Math.min(rows.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") go(rows[at]);
          }}
          role="combobox"
          aria-expanded="true"
          aria-controls="cmd-list"
          aria-label="Search screens and clients"
          autoComplete="off"
          placeholder="Search screens and clients"
          className={inputCls}
        />
        <ul id="cmd-list" role="listbox" ref={list} className="mt-1.5 max-h-[50vh] overflow-y-auto">
          {rows.map((r, i) => (
            <li
              key={r.id}
              data-i={i}
              role="option"
              aria-selected={i === at}
              onMouseMove={() => setAt(i)}
              onClick={() => go(r)}
              className={`flex min-h-11 cursor-pointer items-center gap-2.5 rounded-2xl px-3 text-[15px] ${i === at ? "bg-[#14201B]/[0.07] text-[#14201B]" : "text-[#3D4A44]"}`}
            >
              <Ico name={r.icon} />
              <span className="truncate">{r.label}</span>
              {r.hint &&
                (r.hint.startsWith("G ") ? (
                  <span className="kbd ml-auto">{r.hint}</span>
                ) : (
                  <span className="ml-auto truncate text-[13px] text-[#8A928C]">{r.hint}</span>
                ))}
            </li>
          ))}
          {rows.length === 0 && <li className="px-3 py-3 text-[14px] text-[#8A928C]">No match.</li>}
        </ul>
      </div>
    </div>
  );
}
