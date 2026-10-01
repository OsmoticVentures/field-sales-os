"use client";

/**
 * Add a stop to the active day: an account already in the book (searched,
 * never typed through Places), a lunch/hotel/other stop (resolved through
 * Google Places before it is added, never saved un-placed), or a phone-only
 * call. Adapted from the NutriBiotic OS's AddStopForm/ClientSearchField/
 * AddCallForm (RoutePanel.tsx, ClientSearchField.tsx).
 *
 * The "Add a call" field searches the shared HubSpot portal as you type
 * (CallSearchField below, over api/route/call-search): a contact or a
 * company, with a phone when the portal has one. Picking a result fills
 * both fields; nothing locks, so a wrong autofill is one keystroke to fix,
 * and a name HubSpot has never heard of still types straight through.
 *
 * SDR (2026-09-25, from the source map's "+" sheet): the same account search,
 * then a priority, queues a call on nb_sdr_schedule for the active day
 * through /api/prospect/schedule, the route Prospect already posts to.
 */
import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/core/api";
import { Ico, SuccessNote, inputCls } from "@/lib/core/ui";
import { dayLabel } from "@/lib/features/route/field-week";
import { rankMatches } from "@/lib/features/route/search-match";
import { CUSTOM_STOP_LABEL } from "@/lib/features/route/types";
import type { CustomStop, RouteAccount } from "@/lib/features/route/types";

type AddKind = "client" | "stop" | "sdr";

const STOP_HINT = "Lunch, hotel, any address or place name";

const SDR_PRIORITIES: { value: "low" | "mid" | "high"; label: string; tone: string }[] = [
  { value: "low", label: "Low", tone: "bg-[#ECEAE1] text-[#5B6560]" },
  { value: "mid", label: "Mid", tone: "bg-[#E7EDE4] text-[#3D6B4A]" },
  { value: "high", label: "High", tone: "bg-[#F3E3C6] text-[#8A6D2F]" },
];

export function AddStop({
  accounts,
  inRoute,
  activeDay,
  onAddAccount,
  onAddCustomStop,
}: {
  accounts: RouteAccount[];
  inRoute: Set<string>;
  activeDay: string;
  onAddAccount: (a: RouteAccount) => void;
  onAddCustomStop: (stop: Omit<CustomStop, "id">) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<AddKind>("client");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sdrAccount, setSdrAccount] = useState<RouteAccount | null>(null);
  const [sdrQueued, setSdrQueued] = useState<string | null>(null);

  const searchable = useMemo(() => accounts.filter((a) => a.lifecycle !== "waypoint"), [accounts]);
  const results = useMemo(() => {
    if ((kind !== "client" && kind !== "sdr") || query.trim().length < 2) return [];
    return rankMatches(query, searchable, (a) => ({ name: a.name, also: [a.city, a.state] }), 8);
  }, [kind, query, searchable]);

  function reset() {
    setQuery("");
    setError(null);
    setSdrAccount(null);
    setSdrQueued(null);
  }

  async function queueSdr(priority: "low" | "mid" | "high") {
    if (!sdrAccount || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch("/api/prospect/schedule", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({ account_id: sdrAccount.id, kind: "call", scheduled_date: activeDay, priority }),
      });
      const j: { ok: boolean; error?: string } = await res.json();
      if (!j.ok) {
        setError(j.error ?? "Not scheduled. Try again.");
        return;
      }
      setSdrQueued(sdrAccount.name);
      setTimeout(() => {
        reset();
        setOpen(false);
      }, 1000);
    } catch {
      setError("Not scheduled. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitStop(e: React.FormEvent) {
    e.preventDefault();
    if (busy || kind !== "stop") return;
    setBusy(true);
    setError(null);
    let json: { ok: boolean; place?: { label: string; address: string; lat: number; lng: number }; error?: string };
    try {
      const res = await apiFetch("/api/route/lookup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, mode: "resolve" }),
      });
      json = await res.json();
    } catch {
      setBusy(false);
      setError("Couldn't reach the lookup. Try again.");
      return;
    }
    setBusy(false);
    if (!json.ok || !json.place) {
      setError(json.error ?? "No match. Try the city name too.");
      return;
    }
    onAddCustomStop({ kind: "stop", label: json.place.label, address: json.place.address, lat: json.place.lat, lng: json.place.lng });
    reset();
    setOpen(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setKind("client");
          reset();
          setOpen(true);
        }}
        className="glass inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium text-[#3D4A44] transition-transform active:scale-[0.97]"
      >
        <Ico name="pin" size={14} />
        Add a stop or SDR
      </button>
    );
  }

  const pills: { value: AddKind; label: string }[] = [
    { value: "client", label: "Client" },
    { value: "stop", label: CUSTOM_STOP_LABEL.stop },
    { value: "sdr", label: "SDR" },
  ];

  return (
    <div className="rounded-lg border border-[#E2DFD5] bg-white p-3.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {pills.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => {
              setKind(p.value);
              reset();
            }}
            className={`min-h-11 rounded-full px-4 py-1.5 text-[13px] font-medium transition-transform active:scale-[0.97] ${
              kind === p.value ? "glass-dark" : "glass text-[#3D4A44]"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {kind === "client" && (
        <div className="mt-2.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your accounts"
            autoFocus
            className={inputCls}
          />
          {query.trim().length >= 2 && (
            <ul className="mt-1.5 max-h-64 overflow-auto rounded-md border border-[#E2DFD5]">
              {results.length === 0 && <li className="px-3 py-2 text-[13px] text-[#8A928C]">No account by that name.</li>}
              {results.map((a) => {
                const already = inRoute.has(a.id);
                const where = [a.city, a.state].filter(Boolean).join(", ");
                return (
                  <li key={a.id}>
                    <button
                      type="button"
                      disabled={already}
                      onClick={() => {
                        onAddAccount(a);
                        reset();
                        setOpen(false);
                      }}
                      className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left text-[14px] hover:bg-[#FAF9F5] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-[#14201B]">{a.name}</span>
                        {where && <span className="block truncate text-[12px] text-[#8A928C]">{where}</span>}
                      </span>
                      {already && <span className="shrink-0 text-[12px] text-[#8A928C]">on this day</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {kind === "sdr" && (
        <div className="mt-2.5">
          {sdrQueued ? (
            <SuccessNote title={`${sdrQueued} on SDR, ${dayLabel(activeDay).weekday} ${dayLabel(activeDay).short}`} />
          ) : sdrAccount ? (
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[14px] font-medium text-[#14201B]">{sdrAccount.name}</span>
                <button type="button" onClick={() => setSdrAccount(null)} className="min-h-11 shrink-0 px-2 text-[13px] font-medium text-[#8A928C]">
                  Change
                </button>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                {SDR_PRIORITIES.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    disabled={busy}
                    onClick={() => queueSdr(p.value)}
                    className={`glass min-h-11 flex-1 rounded-xl px-2 text-[13px] font-semibold transition-transform active:scale-[0.97] disabled:opacity-40 ${p.tone}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {error && <span className="mt-1.5 block text-[13px] text-[#8A2E2E]">{error}</span>}
            </div>
          ) : (
            <>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your accounts" autoFocus className={inputCls} />
              {query.trim().length >= 2 && (
                <ul className="mt-1.5 max-h-64 overflow-auto rounded-md border border-[#E2DFD5]">
                  {results.length === 0 && <li className="px-3 py-2 text-[13px] text-[#8A928C]">No account by that name.</li>}
                  {results.map((a) => {
                    const where = [a.city, a.state].filter(Boolean).join(", ");
                    return (
                      <li key={a.id}>
                        <button
                          type="button"
                          onClick={() => setSdrAccount(a)}
                          className="flex min-h-11 w-full items-center px-3 py-2 text-left text-[14px] hover:bg-[#FAF9F5]"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-[#14201B]">{a.name}</span>
                            {where && <span className="block truncate text-[12px] text-[#8A928C]">{where}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
          {!sdrQueued && (
            <button type="button" onClick={() => setOpen(false)} className="mt-2.5 inline-flex min-h-11 items-center text-[13px] font-medium text-[#8A928C]">
              Cancel
            </button>
          )}
        </div>
      )}

      {kind === "stop" && (
        <form onSubmit={submitStop} className="mt-2.5 flex flex-col gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={STOP_HINT} autoFocus className={inputCls} />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || query.trim().length < 3}
              className="min-h-11 glass-dark rounded-xl px-3.5 py-2 text-[13px] font-semibold transition-transform active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Finding" : "Add to route"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="glass min-h-11 rounded-xl px-3 py-2 text-[13px] font-medium text-[#5B6560]">
              Cancel
            </button>
          </div>
          {error && <span className="text-[13px] text-[#8A2E2E]">{error}</span>}
        </form>
      )}

      {kind === "client" && (
        <button type="button" onClick={() => setOpen(false)} className="mt-2.5 inline-flex min-h-11 items-center text-[13px] font-medium text-[#8A928C]">
          Cancel
        </button>
      )}
    </div>
  );
}
