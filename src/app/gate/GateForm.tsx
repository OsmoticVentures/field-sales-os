"use client";

import { apiFetch } from "@/lib/core/api";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { primaryBtn } from "../../lib/core/ui";

/**
 * Where to land after the PIN: the screen that was asked for, not a fixed
 * home. Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/gate/GateForm.tsx), paths adjusted for this
 * app's own (basePath-relative) routes: no "/nutribiotic" prefix here.
 *
 * VALIDATED HERE, NOT TRUSTED FROM THE URL: a redirect target is
 * attacker-reachable by definition (anyone can hand Juan a gate link), so
 * this accepts only an absolute path inside this app, and excludes the gate
 * itself so a bounce cannot loop.
 */
const HOME = "/expenses";

function safeNext(search: string): string {
  const raw = new URLSearchParams(search).get("next");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return HOME;
  if (raw.startsWith("/gate")) return HOME;
  return raw;
}

/** A name for the tile being unlocked, so the devices list can say
 *  "iPhone · Expenses" rather than a bare "iPhone". Only the client knows
 *  this: an installed web app sends the same User-Agent as Safari. */
function surfaceHint(): string {
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!standalone) return "browser";
  const next = new URLSearchParams(window.location.search).get("next") ?? "";
  if (next.startsWith("/expenses")) return "Expenses";
  return "home screen";
}

export function GateForm() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(true);
  const [notRemembered, setNotRemembered] = useState<{ why: "full" | "error"; limit: number } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const res = await apiFetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin, remember, surface: surfaceHint() }),
      });
      const j = await res.json();
      if (j.ok && (j.remembered === "full" || j.remembered === "error")) {
        setNotRemembered({ why: j.remembered, limit: typeof j.device_limit === "number" ? j.device_limit : 0 });
        return;
      }
      if (j.ok) {
        router.replace(safeNext(window.location.search));
        router.refresh();
        return;
      }
      setErr(
        j.attempts_left != null && !j.locked
          ? `${j.message} ${j.attempts_left} attempt${j.attempts_left === 1 ? "" : "s"} left.`
          : j.message || "Could not unlock.",
      );
    } catch {
      setErr("Network error.");
    } finally {
      setBusy(false);
      setPin("");
    }
  }

  if (notRemembered !== null) {
    return (
      <div className="flex min-h-[70vh] items-center justify-center px-5">
        <div className="w-full max-w-[360px]">
          <div className="text-[23px] font-semibold tracking-tight">Unlocked, not remembered</div>
          <p className="mt-2 text-[13.5px] leading-relaxed text-[#5B6560]">
            {notRemembered.why === "full"
              ? `${notRemembered.limit} devices are already remembered. You are signed in for the next eight hours, but this one will ask again.`
              : "The PIN was right and you are signed in for the next eight hours, but this device could not be remembered."}
          </p>
          <button
            onClick={() => {
              router.replace(safeNext(window.location.search));
              router.refresh();
            }}
            className={`mt-5 w-full ${primaryBtn}`}
          >
            Continue
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-5">
      <form onSubmit={submit} className="w-full max-w-[330px]">
        <div className="text-[23px] font-semibold tracking-tight">Field Sales OS</div>
        <p className="mt-1.5 text-[13.5px] text-[#5B6560]">Enter your PIN to unlock.</p>

        <input
          type="password"
          inputMode="numeric"
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          className="mt-5 w-full rounded-md border border-[#D8D4C8] bg-white px-3 py-2.5 text-[16px] tracking-[0.3em] outline-none focus:border-[#14201B]"
          placeholder="••••"
          aria-label="PIN"
        />

        <label className="mt-3.5 flex cursor-pointer items-center gap-2.5 text-[13.5px] text-[#3D4A44]">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-[17px] w-[17px] shrink-0 accent-[#14201B]"
          />
          Remember this device
        </label>

        <button
          type="submit"
          disabled={busy || pin.length < 4}
          className={`mt-3 w-full ${primaryBtn}`}
        >
          {busy ? "Checking" : "Unlock"}
        </button>

        {err && (
          <p role="alert" className="mt-3 text-[13px] text-[#A0762C]">
            {err}
          </p>
        )}
      </form>
    </div>
  );
}
