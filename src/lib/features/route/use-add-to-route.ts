/**
 * Add one client to a day's route, from any screen that shows the client
 * (the SDR call card, the client side panel). Reads which day the client is
 * already on after the screen paints, then appends through /api/route/add,
 * which reads the day's saved order on the server, so a stale screen can
 * never overwrite stops added elsewhere and a second tap never doubles one.
 */
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../core/api";
import { planningHorizonDates } from "./field-week";
import type { RouteDraftEntry } from "./types";

export function useAddToRoute(accountId: string | null | undefined) {
  const days = useMemo(() => planningHorizonDates(), []);
  const [onDay, setOnDay] = useState<{ id: string; day: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failedFor, setFailedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    apiFetch(`/api/account/live?id=${encodeURIComponent(accountId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { ok?: boolean; routeDraftByDay?: Record<string, RouteDraftEntry[]> }) => {
        if (!alive || !j.ok) return;
        const byDay = j.routeDraftByDay ?? {};
        const day = days.find((d) => (byDay[d] ?? []).some((e) => (typeof e === "string" ? e : e.id) === accountId)) ?? null;
        setOnDay((cur) => (cur?.id === accountId && cur.day ? cur : { id: accountId, day }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [accountId, days]);

  async function add(day: string): Promise<boolean> {
    if (!accountId || busy) return false;
    setBusy(true);
    setFailedFor(null);
    try {
      const res = await apiFetch("/api/route/add", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ day, ids: [accountId] }),
      });
      const j = (await res.json()) as { ok?: boolean };
      if (!res.ok || !j.ok) throw new Error("add failed");
      setOnDay({ id: accountId, day });
      return true;
    } catch {
      setFailedFor(accountId);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const scheduledDay = onDay && onDay.id === accountId ? onDay.day : null;
  return { days, scheduledDay, busy, failed: failedFor !== null && failedFor === accountId, add };
}
