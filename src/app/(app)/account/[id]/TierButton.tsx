"use client";

import { useState } from "react";
import { apiFetch } from "../../../../lib/core/api";
import { Ico, eyebrowCls } from "../../../../lib/core/ui";

const LETTERS = ["A", "B", "C", "D", "E", "F", "G"] as const;
const press = "transition-transform active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100";

const WARMTH: Record<string, string> = { urgent: "Urgent", hot: "Hot", normal: "Normal", cold: "Cold" };

export type SdrEntry = { kind: string; date: string; label: string };

export function TierButton({
  accountId,
  initialTier,
  score,
  warmth,
  leadStatus,
  sdr,
}: {
  accountId: string;
  initialTier: string | null;
  score: number | null;
  warmth: string | null;
  leadStatus: string | null;
  sdr: SdrEntry[];
}) {
  const [tier, setTier] = useState<string | null>(initialTier);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(false);

  async function pick(t: string) {
    if (busy || saved) return;
    const next = tier === t ? null : t;
    setBusy(true);
    setFailed(false);
    try {
      const res = await apiFetch("/api/prospect/account-fact", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ account_id: accountId, field: "potential_juan", value: next }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (!res.ok || j.ok === false) throw new Error("save");
      setTier(next);
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        setOpen(false);
      }, 1000);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const warmthLabel = warmth ? WARMTH[warmth] ?? warmth : null;

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Tier"
        className={`inline-flex min-h-11 items-center gap-2 rounded-md border border-[#E2DFD5] bg-white px-2.5 ${press}`}
      >
        {tier ? (
          <span className="grid h-7 w-7 place-items-center rounded bg-[#14201B] text-[14px] font-semibold text-[#F7F6F1]">{tier}</span>
        ) : (
          <Ico name="edit" size={14} />
        )}
        {score !== null && <span className="text-[15px] font-semibold text-[#3D4A44] tabular-nums">{score}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 w-[280px] rounded-lg border border-[#E2DFD5] bg-white p-4 shadow-lg">
          <div className={`mb-2 ${eyebrowCls}`}>Tier</div>
          <div className="flex gap-1">
            {LETTERS.map((t) => (
              <button
                key={t}
                type="button"
                disabled={busy}
                aria-pressed={tier === t}
                onClick={() => pick(t)}
                className={`h-9 w-9 rounded text-[13px] font-semibold ${press} ${
                  tier === t ? "bg-[#14201B] text-[#F7F6F1]" : "bg-[#ECEAE1] text-[#3D4A44] hover:bg-[#E2DFD5]"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="mt-2 h-5 text-[13px]">
            {saved && (
              <span className="inline-flex items-center gap-1.5 text-[#2E6B4A]">
                <Ico name="check" size={13} />
                Saved
              </span>
            )}
            {failed && <span className="text-[#8A2E2E]">Not saved. Tap again.</span>}
          </div>
          {(warmthLabel || sdr.length > 0 || leadStatus) && (
            <dl className="mt-2 space-y-2 border-t border-[#E2DFD5] pt-3 text-[13px]">
              {sdr.length > 0 && (
                <div className="flex justify-between gap-3">
                  <dt className="text-[#5B6560]">SDR</dt>
                  <dd className="text-right text-[#14201B]">
                    {sdr.map((e) => (
                      <div key={`${e.kind}-${e.date}`}>{e.label}</div>
                    ))}
                  </dd>
                </div>
              )}
              {leadStatus && (
                <div className="flex justify-between gap-3">
                  <dt className="text-[#5B6560]">Lead status</dt>
                  <dd className="text-right text-[#14201B]">{leadStatus.replace(/_/g, " ").toLowerCase()}</dd>
                </div>
              )}
              {warmthLabel && (
                <div className="flex justify-between gap-3">
                  <dt className="text-[#5B6560]">Warmth</dt>
                  <dd className="text-[#14201B]">{warmthLabel}</dd>
                </div>
              )}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
