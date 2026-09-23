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
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/core/api";
import { Ico, inputCls } from "@/lib/core/ui";
import { rankMatches } from "@/lib/features/route/search-match";
import { CUSTOM_STOP_LABEL } from "@/lib/features/route/types";
import type { CallEntry, CustomStop, CustomStopKind, RouteAccount } from "@/lib/features/route/types";

type CallCandidate = {
  id: string;
  kind: "contact" | "company";
  label: string;
  city: string | null;
  phone: string | null;
  phoneVia: string | null;
};

/** "+17145551234" -> "(714) 555-1234"; anything else shows as stored. */
function prettyPhone(raw: string): string {
  const d = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : raw;
}

function CallSearchField({
  label,
  onChangeLabel,
  onPick,
  className,
}: {
  label: string;
  onChangeLabel: (v: string) => void;
  onPick: (r: CallCandidate) => void;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<CallCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function runSearch(q: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      const seq = ++seqRef.current;
      try {
        const res = await apiFetch(`/api/route/call-search?q=${encodeURIComponent(q)}`);
        const json = (await res.json()) as { ok: boolean; results?: CallCandidate[] };
        if (seq !== seqRef.current) return;
        setResults(json.ok ? (json.results ?? []) : []);
      } catch {
        if (seq === seqRef.current) setResults([]);
      } finally {
        if (seq === seqRef.current) setSearching(false);
      }
    }, 250);
  }

  const q = label.trim();
  const showMenu = open && q.length >= 2;

  return (
    <div className="relative">
      <input
        value={label}
        onChange={(e) => {
          onChangeLabel(e.target.value);
          setOpen(true);
          runSearch(e.target.value);
        }}
        onFocus={() => q.length >= 2 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
        placeholder="Who, e.g. Alex Conrad, Vasari Plaster"
        autoFocus
        className={className}
      />
      {showMenu && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-md border border-[#E2DFD5] bg-white py-1 shadow-lg">
          {searching && <div className="px-3 py-2 text-[12.5px] text-[#8A928C]">Searching HubSpot</div>}
          {!searching && results.length === 0 && (
            <div className="px-3 py-2 text-[12.5px] text-[#8A928C]">No HubSpot match. Type the name and phone by hand.</div>
          )}
          {results.map((r) => (
            <button
              key={`${r.kind}:${r.id}`}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(r);
                setOpen(false);
                setResults([]);
              }}
              className="flex min-h-11 w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[#FAF9F5]"
            >
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13.5px] font-medium text-[#14201B]">{r.label}</span>
                  <span className="shrink-0 rounded bg-[#F0EEE4] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#8A928C]">
                    {r.kind}
                  </span>
                </span>
                {r.phoneVia && <span className="block truncate text-[11.5px] text-[#A9AFA9]">via {r.phoneVia}</span>}
              </span>
              <span className="shrink-0 text-[12.5px] tabular-nums text-[#5B6560]">{r.phone ? prettyPhone(r.phone) : "no phone on file"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type AddKind = CustomStopKind | "client" | "call";

const KIND_HINT: Record<CustomStopKind, string> = {
  lunch: "In-N-Out Tustin",
  hotel: "Hampton Inn Carlsbad",
  stop: "Any address or place name",
};

export function AddStop({
  accounts,
  inRoute,
  onAddAccount,
  onAddCustomStop,
  onAddCall,
}: {
  accounts: RouteAccount[];
  inRoute: Set<string>;
  onAddAccount: (a: RouteAccount) => void;
  onAddCustomStop: (stop: Omit<CustomStop, "id">) => void;
  onAddCall: (call: Omit<CallEntry, "id">) => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<AddKind>("client");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [phone, setPhone] = useState("");
  const [note, setNote] = useState("");

  const searchable = useMemo(() => accounts.filter((a) => a.lifecycle !== "waypoint"), [accounts]);
  const results = useMemo(() => {
    if (kind !== "client" || query.trim().length < 2) return [];
    return rankMatches(query, searchable, (a) => ({ name: a.name, also: [a.city, a.state] }), 8);
  }, [kind, query, searchable]);

  function reset() {
    setQuery("");
    setError(null);
    setLabel("");
    setPhone("");
    setNote("");
  }

  async function submitStop(e: React.FormEvent) {
    e.preventDefault();
    if (busy || kind === "client" || kind === "call") return;
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
    onAddCustomStop({ kind: kind as CustomStopKind, label: json.place.label, address: json.place.address, lat: json.place.lat, lng: json.place.lng });
    reset();
    setOpen(false);
  }

  function submitCall(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !phone.trim()) return;
    onAddCall({ label: label.trim(), phone: phone.trim(), ...(note.trim() ? { note: note.trim() } : {}) });
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
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-[#E2DFD5] bg-white px-3.5 py-2 text-[13px] font-medium text-[#3D4A44] transition-transform active:scale-[0.97] hover:bg-[#FAF9F5]"
      >
        <Ico name="pin" size={14} />
        Add a stop or call
      </button>
    );
  }

  const pills: { value: AddKind; label: string }[] = [
    { value: "client", label: "Client" },
    { value: "lunch", label: CUSTOM_STOP_LABEL.lunch },
    { value: "hotel", label: CUSTOM_STOP_LABEL.hotel },
    { value: "stop", label: CUSTOM_STOP_LABEL.stop },
    { value: "call", label: "Call" },
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
            className={`min-h-11 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
              kind === p.value ? "bg-[#14201B] text-[#F7F6F1]" : "border border-[#E2DFD5] text-[#5B6560] hover:bg-[#FAF9F5]"
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

      {kind !== "client" && kind !== "call" && (
        <form onSubmit={submitStop} className="mt-2.5 flex flex-col gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={KIND_HINT[kind]} autoFocus className={inputCls} />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || query.trim().length < 3}
              className="min-h-11 rounded-md bg-[#2C6A46] px-3.5 py-2 text-[13px] font-semibold text-white transition-transform active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Finding" : "Add to route"}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-md border border-[#E2DFD5] px-3 py-2 text-[13px] font-medium text-[#8A928C]">
              Cancel
            </button>
          </div>
          {error && <span className="text-[13px] text-[#8A2E2E]">{error}</span>}
        </form>
      )}

      {kind === "call" && (
        <form onSubmit={submitCall} className="mt-2.5 flex flex-col gap-2">
          <CallSearchField
            label={label}
            onChangeLabel={setLabel}
            onPick={(r) => {
              setLabel(r.label);
              if (r.phone) setPhone(r.phone);
            }}
            className={inputCls}
          />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" className={`${inputCls} tabular-nums`} />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why you're calling"
            rows={2}
            className="w-full resize-none rounded-md border border-[#E2DFD5] bg-[#FCFBF7] px-3 py-2 text-base outline-none placeholder:text-[#A9AFA9] focus:border-[#8A928C]"
          />
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={!label.trim() || !phone.trim()}
              className="min-h-11 rounded-md bg-[#2C6A46] px-3.5 py-2 text-[13px] font-semibold text-white transition-transform active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Add call
            </button>
            <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-md border border-[#E2DFD5] px-3 py-2 text-[13px] font-medium text-[#8A928C]">
              Cancel
            </button>
          </div>
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
