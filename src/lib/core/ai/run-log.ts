/**
 * One row per AI call in nb_ai_runs (agency migration
 * nutribiotic/supabase/migrations/0098_ai_runs.sql), for error analysis:
 * read the real runs, find the failure modes, fix the prompt or the check.
 * tests/evals/ reads them back offline.
 *
 * BOUNDED (root P9): the row goes in through nb_ai_run_log, which clips every
 * text column and, inside the same call, keeps the table at its row cap and
 * drops anything older than 30 days. A write, never a read: no egress.
 *
 * Best effort and quiet. Until the migration is applied the function is
 * missing (PostgREST 404); the first miss turns logging off for this instance
 * so no call pays for it twice. A logging failure never fails an AI step.
 */
import "server-only";
import type { RunRecord } from "./core";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const WRITE_TIMEOUT_MS = 1_500;

let disabled = false;

export async function writeRunRecord(rec: RunRecord): Promise<void> {
  if (disabled || !SB_URL || !SB_KEY) return;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/nb_ai_run_log`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ p: rec }),
      cache: "no-store",
      signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
    });
    if (res.status === 404) disabled = true;
  } catch {
    // Unreachable or slow: skip this record, keep the step.
  }
}
