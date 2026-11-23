/**
 * The notes drain (lib/features/visit/note-drain.ts). pg_cron's nb_notes_tick
 * POSTs here only when a note is due for raw filing or a HubSpot retry, so an
 * idle tick costs no request. Not behind the PIN: the caller is the database,
 * with the shared secret from nb_job_runner in x-nb-runner, the same as the
 * search drain. A wrong or missing secret files nothing. It acts as Juan, the
 * one rep whose notes go through the inbox.
 */
import { timingSafeEqual } from "../../../../lib/core/session";
import { jobRunnerSecret } from "../../../../lib/features/search/dal";
import { drainNotes } from "../../../../lib/features/visit/note-drain";
import { invalidatePriorityBook } from "../../../../lib/features/prospect/dal";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  const sent = req.headers.get("x-nb-runner") ?? "";
  const secret = sent ? await jobRunnerSecret() : null;
  if (!secret || !timingSafeEqual(sent, secret)) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  try {
    const report = await drainNotes();
    if (report.raw.length) invalidatePriorityBook();
    return Response.json({ ok: !report.error, result: report }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    captureError(err, "/api/notes/drain");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "The drain failed." }, { status: 500 });
  }
}
