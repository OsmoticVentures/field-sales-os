/**
 * Which deployment this process is. Plain module, no secrets, no
 * "server-only": the root layout, instrumentation, the health route and the
 * unit tests all read it.
 *
 *   NB_STAGE=staging                          -> staging (explicit, wins)
 *   VERCEL_ENV=production                     -> production
 *   VERCEL_ENV=preview, branch "staging"      -> staging
 *   VERCEL_ENV=preview, any other branch      -> preview
 *   anything else (next dev, next start)      -> local
 *
 * Staging and every preview run against real-looking screens but must never
 * reach the shared HubSpot portal, so hubspotWritesAllowedHere() is the one
 * place that decision lives (lib/features/visit/hubspot.ts asks it before any
 * push).
 */

export type Stage = "production" | "staging" | "preview" | "local";

/** The production Supabase project ref. Staging refuses to start against it
 *  (src/instrumentation.ts) and the bootstrap script refuses to touch it. */
export const PRODUCTION_SUPABASE_REF = "giodrtaddvmkgvmzomxv";

type Env = Record<string, string | undefined>;

export function stage(env: Env = process.env): Stage {
  if (env.NB_STAGE === "staging") return "staging";
  if (env.VERCEL_ENV === "production") return "production";
  if (env.VERCEL_ENV === "preview") {
    return env.VERCEL_GIT_COMMIT_REF === "staging" ? "staging" : "preview";
  }
  return "local";
}

/** False on staging and every preview, whatever the per-feature env flags
 *  say. Production and local keep their flag-driven behavior. */
export function hubspotWritesAllowedHere(env: Env = process.env): boolean {
  const s = stage(env);
  return s === "production" || s === "local";
}

/** The reason a staging or preview deployment cannot write to HubSpot, or
 *  null where writes are allowed (subject to each feature's own flag). */
export function hubspotStageRefusal(env: Env = process.env): string | null {
  if (hubspotWritesAllowedHere(env)) return null;
  return `HubSpot writes are off on every ${stage(env)} deployment, whatever the env flags say.`;
}

/** Throws when a staging process is pointed at the production database. A
 *  staging deploy that has not been given its own NB_SUPABASE_URL stays dead
 *  instead of writing to the reps' live data. Never throws anywhere else. */
export function assertStagingDatabase(env: Env = process.env): void {
  if (stage(env) !== "staging") return;
  const url = env.NB_SUPABASE_URL ?? "";
  if (url.includes(PRODUCTION_SUPABASE_REF)) {
    throw new Error(
      "Staging refuses to start: NB_SUPABASE_URL points at the production Supabase project. " +
        "Set the staging project's URL and service key for the staging branch.",
    );
  }
}
