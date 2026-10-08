/**
 * The capture loop's by-hand trust check (PORTING.md, "Errors and fixes").
 * Answers 404 unless NB_ERRORS_SELFTEST is "1", which is set only on a local
 * or preview server, never on production. With it on:
 *  - no `n`: a real, harmless TypeError, uncaught, so it travels the path a
 *    production bug would: onRequestError, nb_app_errors, the triage job.
 *  - `?upstream=1`: one Supabase call with a wrong key, which answers 401 and
 *    exercises the upstream watch. Reads nothing.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (process.env.NB_ERRORS_SELFTEST !== "1") return new Response(null, { status: 404 });
  const params = new URL(req.url).searchParams;
  if (params.get("upstream") === "1") {
    const res = await fetch(`${process.env.NB_SUPABASE_URL}/rest/v1/nb_users?select=id&limit=0`, {
      headers: { apikey: "selftest-wrong-key" },
      cache: "no-store",
    });
    return Response.json({ ok: true, upstream: res.status });
  }
  const n = params.get("n");
  const size = (n as unknown as string[]).length;
  return Response.json({ ok: true, size });
}
