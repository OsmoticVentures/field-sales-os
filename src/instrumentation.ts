/**
 * Runs once when a server instance starts, before it takes a request
 * (Next's instrumentation register hook). Its one job: a staging deployment
 * pointed at the production database refuses to start, so a staging branch
 * that was never given its own NB_SUPABASE_URL stays dead instead of writing
 * to the reps' live data. Production, previews and local never throw here
 * (lib/core/stage.ts, covered by tests/stage.test.mts).
 */
import { assertStagingDatabase } from "./lib/core/stage";

export function register() {
  assertStagingDatabase();
}
