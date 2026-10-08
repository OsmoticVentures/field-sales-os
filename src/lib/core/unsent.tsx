"use client";

/**
 * Unsent writes on screen. UnsentList sits on the card a write came from and
 * shows each one with where it stands; a refused one is red, in place, with
 * Try again, Edit (when the card can take it back) and Discard. UnsentStatus
 * is the small count every screen shows while anything waits, visit notes
 * included, and taps through to the screen that holds it.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { BASE_PATH } from "./api";
import { useOutbox } from "./outbox";
import { Ico } from "./ui";
import { discardWrite, retryWrite, takeBackWrite, useWrites, type WqItem } from "./writeq";

function standing(it: WqItem, running: boolean): { word: string; alert: boolean } {
  if (it.failed) return { word: "Not sent", alert: true };
  if (running) return { word: "Sending", alert: false };
  if (it.offline || it.attempts === 0) return { word: "Unsent", alert: false };
  return { word: "Retrying", alert: it.attempts >= 3 };
}

export function UnsentList({ screen, onEdit }: { screen: string; onEdit?: (it: WqItem) => void }) {
  const { items, running } = useWrites();
  const mine = items.filter((it) => it.screen === screen);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  if (mine.length === 0) return null;
  const act = "inline-flex min-h-11 items-center gap-1.5 px-2 text-[13px] text-[#5B6560] transition-transform active:scale-[0.97]";

  return (
    <div className="mt-3 flex flex-col divide-y divide-[#EDEBE3] rounded-xl border border-[#E2DFD5] bg-[#FAF9F5] px-4">
      {mine.map((it) => {
        const s = standing(it, running === it.id);
        const reason = it.failed ?? (s.alert ? it.lastError : null);
        return (
          <div key={it.id} className="py-1">
            <div className="flex min-h-11 items-center justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate text-[#3D4A44]">{it.label}</span>
              <span className={`shrink-0 ${s.alert ? "font-medium text-[#8A2E2E]" : "text-[#8A928C]"}`}>{s.word}</span>
            </div>
            {reason && (
              <div role="alert" className="pb-1 text-[13px] leading-relaxed font-medium text-[#8A2E2E]">
                {reason}
              </div>
            )}
            {(it.failed || it.attempts >= 3) && (
              <div className="flex justify-end gap-1">
                <button type="button" className={act} disabled={running === it.id} onClick={() => void retryWrite(it.id)}>
                  Try again
                </button>
                {onEdit && (
                  <button
                    type="button"
                    className={act}
                    disabled={running === it.id}
                    onClick={async () => {
                      const back = await takeBackWrite(it.id);
                      if (back) onEdit(back);
                    }}
                  >
                    <Ico name="edit" size={13} />
                    Edit
                  </button>
                )}
                <button
                  type="button"
                  className={`${act} ${confirming === it.id ? "font-medium text-[#8A2E2E]" : ""}`}
                  onClick={() => {
                    if (confirming === it.id) {
                      setConfirming(null);
                      void discardWrite(it.id);
                    } else setConfirming(it.id);
                  }}
                >
                  <Ico name="close" size={13} />
                  {confirming === it.id ? "Confirm discard" : "Discard"}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The screen a queued write is shown on, from its `screen` tag. */
const hrefFor = (screen: string) => `/${screen.split("/")[0]}`;

export function UnsentStatus() {
  const writes = useWrites().items;
  const notes = useOutbox().items.filter((it) => !it.filed);
  const pathname = usePathname() ?? "";
  const count = writes.length + notes.length;
  if (count === 0) return null;
  const refused = writes.some((w) => w.failed) || notes.some((n) => n.parked === "rejected");
  // Hidden only when everything waiting is already on this screen.
  const here = (href: string) => pathname === href || pathname === `${BASE_PATH}${href}`;
  const screens = [...(notes.length ? ["/visit"] : []), ...writes.map((w) => hrefFor(w.screen))];
  const target = screens.find((href) => !here(href));
  if (!target) return null;
  return (
    <Link
      href={target}
      className={`fixed right-4 z-40 flex min-h-9 items-center gap-1.5 rounded-full border bg-[#FAF9F5]/95 px-3 text-[12.5px] shadow-sm backdrop-blur transition-transform active:scale-[0.97] [bottom:calc(5.5rem+env(safe-area-inset-bottom))] md:bottom-5 ${
        refused ? "border-[#E8C9C9] font-medium text-[#8A2E2E]" : "border-[#E2DFD5] text-[#5B6560]"
      }`}
    >
      <Ico name={refused ? "alert" : "send"} size={12} />
      {refused ? `${count} not sent` : `${count} unsent`}
    </Link>
  );
}
