/**
 * Runs once when a server instance starts, before it takes a request
 * (Next's instrumentation register hook).
 *
 * register():
 *  - a staging deployment pointed at the production database refuses to
 *    start, so a staging branch that was never given its own NB_SUPABASE_URL
 *    stays dead instead of writing to the reps' live data. Production,
 *    previews and local never throw here (lib/core/stage.ts, covered by
 *    tests/stage.test.mts).
 *  - on Node, starts the upstream watch (lib/core/upstream-watch.ts): any
 *    Supabase, HubSpot, Anthropic or Google call that answers badly lands in
 *    nb_app_errors.
 *
 * onRequestError(): anything a route handler, a server render or the proxy
 * threw and did not catch, into nb_app_errors via lib/core/errors.ts.
 */
import type { Instrumentation } from "next";
import { assertStagingDatabase } from "./lib/core/stage";

export async function register() {
  assertStagingDatabase();
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { watchUpstream } = await import("./lib/core/upstream-watch");
  watchUpstream();
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const e = err as Error & { digest?: string };
    const { captureNow, repFromCookieHeader } = await import("./lib/core/errors");
    await captureNow({
      rep: await repFromCookieHeader(request.headers.cookie),
      kind: "server",
      message: `${e.name ?? "Error"}: ${e.message ?? ""}`,
      stack: e.stack,
      route: context.routePath || request.path,
    });
  } catch {
    // never let reporting become the failure
  }
};
