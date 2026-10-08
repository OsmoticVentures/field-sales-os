/**
 * The minute drain. pg_cron (supabase/0002_durable_search_jobs.sql) sweeps
 * nb_search_jobs inside Postgres every minute and POSTs here only when a row
 * is ready, so an idle minute costs no request and no egress. This route
 * starts up to DRAIN_MAX ready jobs on this server, after answering.
 *
 * Not behind the PIN: the caller is the database. It must send the shared
 * secret from nb_job_runner in x-nb-runner. A wrong or missing secret gets a
 * 401 and starts nothing; even a right one can only start jobs a signed-in
 * rep already queued.
 */
import { after } from "next/server";
import { timingSafeEqual } from "../../../../lib/core/session";
import { durableQueue, jobRunnerSecret, listPendingJobIds, sweepSearchJobs } from "../../../../lib/features/search/dal";
import { runSearchJob } from "../../../../lib/features/search/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The jobs run after the response, inside this window (same as /api/search).
export const maxDuration = 300;

const DRAIN_MAX = 3;

export async function POST(req: Request) {
  const sent = req.headers.get("x-nb-runner") ?? "";
  if (!sent) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  if (!(await durableQueue())) {
    return Response.json({ ok: false, error: "The durable queue is not set up." }, { status: 503 });
  }
  const secret = await jobRunnerSecret();
  if (!secret || !timingSafeEqual(sent, secret)) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let ids: string[];
  try {
    await sweepSearchJobs();
    ids = await listPendingJobIds(DRAIN_MAX);
  } catch {
    return Response.json({ ok: false, error: "Could not read the queue." }, { status: 502 });
  }
  if (ids.length) {
    after(() => Promise.all(ids.map((id) => runSearchJob(id))).then(() => undefined));
  }
  return Response.json({ ok: true, started: ids.length }, { headers: { "cache-control": "no-store" } });
}
