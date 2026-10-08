/**
 * The day's AI spend counter: one row per Pacific day in nb_ai_spend_days
 * (supabase/0009_ai_spend_cap.sql), read and written only through two RPCs.
 *
 *   reserve: nb_ai_spend_reserve adds a call's estimate to the day's held
 *            amount in ONE conditional UPDATE, and only while spent + held +
 *            this estimate stays within AI_DAILY_CAP_USD. Postgres locks the
 *            row and re-checks the condition for every concurrent caller, so
 *            two serverless instances can never both take the last dollar.
 *   settle:  nb_ai_spend_settle swaps the held amount for the real cost.
 *
 * About 100 bytes each way per call, no table read from the app, no polling.
 *
 * FAILS CLOSED. A counter that cannot be reached refuses the call: the cap is
 * hard, so an unknown total is treated as a full one. The first refusal of a
 * day files one nb_app_errors row inside the same SQL call (fingerprint
 * aicap-YYYY-MM-DD), and bridges/clientos/errors_triage.py texts Juan from it.
 */
import "server-only";
import { AI_DAILY_CAP_USD, type Budget, type SpendTicket } from "./core";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const RPC_TIMEOUT_MS = 2_500;

async function rpc(name: string, body: unknown): Promise<Response> {
  return fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
}

async function reserveOnce(usd: number): Promise<Awaited<ReturnType<Budget["reserve"]>>> {
  const res = await rpc("nb_ai_spend_reserve", { p_usd: usd, p_cap: AI_DAILY_CAP_USD });
  if (!res.ok) return { ok: false, reason: "unavailable" };
  const j = (await res.json().catch(() => null)) as { ok?: unknown; day?: unknown } | null;
  if (j?.ok === true && typeof j.day === "string") return { ok: true, ticket: { day: j.day, usd } };
  if (j?.ok === false) return { ok: false, reason: "cap" };
  return { ok: false, reason: "unavailable" };
}

export const spendLedger: Budget = {
  async reserve(usd) {
    if (!SB_URL || !SB_KEY) return { ok: false, reason: "unavailable" };
    // One retry on a dropped connection; a refusal is final.
    for (let i = 0; i < 2; i += 1) {
      try {
        const r = await reserveOnce(usd);
        if (r.ok || r.reason === "cap") return r;
      } catch {
        // unreachable or slow: the second try, then fail closed
      }
    }
    return { ok: false, reason: "unavailable" };
  },

  async settle(ticket: SpendTicket, actualUsd: number) {
    if (!SB_URL || !SB_KEY) return;
    try {
      await rpc("nb_ai_spend_settle", { p_day: ticket.day, p_reserved: ticket.usd, p_actual: actualUsd });
    } catch {
      // The held amount stays on the day until the stale-hold reset (3 min):
      // an over-count, never an under-count.
    }
  },
};
