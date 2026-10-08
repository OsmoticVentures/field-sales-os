/**
 * Runs one queued search job to the end, on this server. Ported from
 * bridges/nutribiotic/search_worker.py's run_job(): claim atomically, run the
 * stage, write the summary (or the crash) back onto the row. Never throws, so
 * a failure is always a row the screen can read, never a job left spinning.
 *
 *   done     the stage answered; `result` is its summary verbatim, and it may
 *            itself carry ok:false with `errors` (Google unreachable, say).
 *   pending  a passing failure (the network) with a try left: back in the
 *            queue, where the next poll or the minute drain picks it up.
 *   error    the runner itself failed, or its tries are spent.
 *
 * A function killed mid-run never reaches any of these; its lease lapses and
 * the sweep (supabase/0002_durable_search_jobs.sql) does the same thing.
 */
import "server-only";
import { claimSearchJob, durableQueue, finishSearchJob, pruneSearchJobs, requeueSearchJob } from "./dal";
import { isTransient } from "./lease";
import { PlacesError, stageRequest } from "./pipeline";
import { captureError } from "@/lib/core/errors";

const PRUNE_EVERY_MS = 30 * 60_000;
let lastPrune = 0;

export async function runSearchJob(id: string): Promise<void> {
  let row;
  try {
    row = await claimSearchJob(id);
  } catch (e) {
    console.error(`search job ${id}: claim failed`, e);
    captureError(e, "lib/search/worker");
    return;
  }
  if (!row) return; // already taken by another runner

  const stage = row.stage;
  let params = row.params ?? {};
  if (typeof params === "string") params = JSON.parse(params) as Record<string, unknown>;

  const started = Date.now();
  const lines: string[] = [];
  let result: Record<string, unknown>;
  try {
    result = await stageRequest(stage, params, (m) => lines.push(m));
  } catch (e) {
    if (e instanceof PlacesError) {
      result = { ok: false, stage, errors: [e.message], candidates: [] };
    } else {
      const err = e as Error;
      console.error(`search job ${id} (${stage}) crashed on try ${row.attempts ?? 1}`, err);
      const triesLeft = (row.max_attempts ?? 1) - (row.attempts ?? 1);
      if (triesLeft > 0 && isTransient(e) && (await durableQueue())) {
        await requeueSearchJob(id).catch(() => undefined);
        return;
      }
      captureError(err, "lib/search/worker");
      await finishSearchJob(id, { error: `${err?.name ?? "Error"}: ${err?.message ?? String(e)}` }).catch(() => undefined);
      return;
    }
  }
  result.log = lines;
  try {
    await finishSearchJob(id, { result });
  } catch (e) {
    console.error(`search job ${id}: could not record the result`, e);
    captureError(e, "lib/search/worker");
    await finishSearchJob(id, { error: "The run finished but its result could not be saved. Run it again." }).catch(() => undefined);
    return;
  }
  console.log(
    `search job ${id} ${stage} -> ${result.ok ? "ok" : "reported errors"} in ${((Date.now() - started) / 1000).toFixed(1)}s, ` +
      `${((result.candidates as unknown[]) ?? []).length} candidate(s)`,
  );

  if (Date.now() - lastPrune > PRUNE_EVERY_MS) {
    lastPrune = Date.now();
    await pruneSearchJobs().catch((e) => console.error("search job prune failed", e));
  }
}
