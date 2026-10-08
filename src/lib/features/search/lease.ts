/**
 * The durable queue's pure rules, kept apart from dal.ts (server-only) so
 * tests can run them: how many tries a stage gets, when a running row's
 * function is presumed dead, and which failures are worth a second try.
 */

export type LeaseRow = {
  status: string;
  started_at: string | null;
  lease_until?: string | null;
};

/** How many times a stage may be started. A run that writes (land with
 *  write:true) gets one: a second try after a half-finished write would see
 *  its own rows as "already in the book" and report the wrong thing. Search
 *  and enrich only read, so one retry costs Places calls and nothing else. */
export function maxAttemptsFor(stage: string, params: Record<string, unknown>): number {
  return stage === "land" && params.write === true ? 1 : 2;
}

/** A row claimed without a lease (the Mac worker, or before the migration)
 *  is presumed dead after this long. */
export const STALE_RUNNING_MIN = 20;

/** Did this run's function die? A lease that lapsed, or for a lease-less
 *  row, 20 minutes since it started. */
export function runLapsed(job: LeaseRow, now = Date.now()): boolean {
  if (job.status !== "running") return false;
  if (job.lease_until) return Date.parse(job.lease_until) < now;
  if (!job.started_at) return false;
  return now - Date.parse(job.started_at) > STALE_RUNNING_MIN * 60_000;
}

/** A failure that says nothing about the job itself: the network or an
 *  upstream that was briefly down. Anything else is a real error and fails
 *  in place on the first try. */
export function isTransient(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|HTTP 50[234]/i.test(msg);
}
