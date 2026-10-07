"use client";

/**
 * The client view, painted from the phone's copy of the book (phone-sync.ts)
 * with no server wait. Serves both the slide-over and the full page. The
 * route draft and SDR entries move by the minute, so they are read live and
 * merged in when they arrive; until then Add to route stays hidden, since it
 * appends to a day's draft and must not write over one it has not read.
 */
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../../../lib/core/api";
import {
  onAccountPayload,
  patchAccount,
  peekAccountPayload,
  getAccountPayload,
  readStoredAccount,
  refreshAccount,
  storeAccount,
} from "../../../../lib/core/phone-sync";
import { PageHead } from "../../../../lib/core/ui";
import type { AccountLive, AccountPayload } from "../../../../lib/features/clients/account-payload";
import { WarmthPicker } from "../../../../lib/features/clients/WarmthPicker";
import { realChannel } from "../../../../lib/features/clients/ui";
import { planningHorizonDates } from "../../../../lib/features/route/field-week";
import { AccountView } from "./AccountView";
import AccountSkeleton from "./loading";
import { TierButton } from "./TierButton";

type Status = "reading" | "fetching" | "offline" | "missing";

export function AccountClient({ id, initial, initialLive }: { id: string; initial?: AccountPayload; initialLive?: AccountLive }) {
  const [payload, setPayload] = useState<AccountPayload | null>(() => initial ?? peekAccountPayload(id) ?? null);
  const [status, setStatus] = useState<Status>("reading");
  const [live, setLive] = useState<AccountLive | null>(initialLive ?? null);

  useEffect(() => {
    let alive = true;
    const off = onAccountPayload(id, (p) => {
      if (alive) setPayload(p);
    });
    if (initial) {
      void storeAccount(id, initial);
    } else if (!peekAccountPayload(id)) {
      void (async () => {
        const stored = await readStoredAccount(id);
        if (!alive) return;
        if (stored) return setPayload(stored);
        setStatus("fetching");
        const r = await getAccountPayload(id);
        if (!alive) return;
        if ("payload" in r) setPayload(r.payload);
        else setStatus("missing" in r ? "missing" : "offline");
      })();
    }
    return () => {
      alive = false;
      off();
    };
  }, [id, initial]);

  useEffect(() => {
    if (initialLive) return;
    let alive = true;
    apiFetch(`/api/account/live?id=${encodeURIComponent(id)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { ok?: boolean } & Partial<AccountLive>) => {
        if (alive && j.ok) setLive({ routeDraftByDay: j.routeDraftByDay ?? {}, sdr: j.sdr ?? [] });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, initialLive]);

  const routeDays = useMemo(() => (live ? planningHorizonDates() : []), [live]);

  if (!payload) {
    if (status === "fetching") return <AccountSkeleton />;
    if (status === "offline") return <p className="py-6 text-[15px] text-[#5B6560]">No connection.</p>;
    if (status === "missing") return <p className="py-6 text-[15px] text-[#5B6560]">Client not found.</p>;
    return null;
  }

  const a = payload.account;
  const sub = [realChannel(a.channel), [a.street, a.city, a.postal].filter(Boolean).join(", ")].filter(Boolean).join(" · ");

  return (
    <>
      <PageHead
        title={a.name}
        sub={sub || undefined}
        aside={
          <TierButton
            accountId={a.id}
            initialTier={payload.initialTier}
            tierIsMine={payload.tierIsMine}
            score={payload.score}
            warmth={payload.warmth}
            leadStatus={payload.leadStatus}
            sdr={live?.sdr ?? []}
            onSaved={(tier) => {
              void patchAccount(id, (p) => ({
                ...p,
                account: { ...p.account, potential_juan: tier },
                initialTier: tier ?? (p.account.potential_hq?.split(" ")[0] || null),
                tierIsMine: tier !== null,
              })).then(() => refreshAccount(id));
            }}
          />
        }
      />
      <div className="mb-4">
        <WarmthPicker
          key={`warmth-${a.id}`}
          accountId={a.id}
          value={payload.warmth}
          onSaved={(w) => void patchAccount(id, (p) => ({ ...p, warmth: w })).then(() => refreshAccount(id))}
        />
      </div>
      <AccountView
        account={a}
        contacts={payload.contacts}
        activities={payload.activities}
        orders={payload.orders}
        lines={payload.lines}
        routeDays={routeDays}
        routeDraftByDay={live?.routeDraftByDay ?? {}}
      />
    </>
  );
}
