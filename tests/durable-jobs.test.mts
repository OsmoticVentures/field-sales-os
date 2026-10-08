// The durable search queue's pure rules and the per-rep flag resolver.
// Run: node --experimental-strip-types tests/durable-jobs.test.mts
import { isTransient, maxAttemptsFor, runLapsed } from "../src/lib/features/search/lease.ts";
import { REP_FLAGS, resolveFlags } from "../src/lib/core/rep-flags.ts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}`, info ?? "");
  } else console.log(`ok   ${name}`);
};

const now = Date.parse("2026-10-08T12:00:00Z");
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

// Leases
t("pending is never lapsed", !runLapsed({ status: "pending", started_at: iso(3_600_000) }, now));
t("running inside its lease", !runLapsed({ status: "running", started_at: iso(60_000), lease_until: iso(-200_000) }, now));
t("running past its lease", runLapsed({ status: "running", started_at: iso(400_000), lease_until: iso(70_000) }, now));
t("lease-less row, 10 minutes", !runLapsed({ status: "running", started_at: iso(600_000), lease_until: null }, now));
t("lease-less row, 21 minutes", runLapsed({ status: "running", started_at: iso(21 * 60_000) }, now));
t("done is never lapsed", !runLapsed({ status: "done", started_at: iso(3_600_000), lease_until: iso(3_000_000) }, now));

// Attempts
t("search gets a retry", maxAttemptsFor("search", {}) === 2);
t("enrich gets a retry", maxAttemptsFor("enrich", { candidates: [] }) === 2);
t("a dry land gets a retry", maxAttemptsFor("land", { write: false }) === 2);
t("a writing land runs once", maxAttemptsFor("land", { write: true }) === 1);

// Which failures earn the retry
t("fetch failed is transient", isTransient(new TypeError("fetch failed")));
t("a 503 is transient", isTransient(new Error("Supabase nb_accounts -> HTTP 503: down")));
t("a 400 is not", !isTransient(new Error("Supabase nb_accounts -> HTTP 400: bad column")));
t("a bug is not", !isTransient(new TypeError("Cannot read properties of undefined")));

// Flags: the file is the default
const fileDefault = Object.keys(REP_FLAGS).filter((n) => REP_FLAGS[n].on.includes("kyle")).sort();
t("no rows, kyle gets the file", JSON.stringify(resolveFlags("kyle", [])) === JSON.stringify(fileDefault));
t("no rows, juan gets the file", resolveFlags("juan", []).every((n) => REP_FLAGS[n]?.on.includes("juan")));
t("no user, nothing", resolveFlags(null, [{ flag: "x", rep: "*", value: true }]).length === 0);
t(
  "a row turns a flag on for one rep",
  resolveFlags("juan", [{ flag: "no-area-filters", rep: "juan", value: true }]).includes("no-area-filters"),
);
t(
  "a row turns the file's default off",
  !resolveFlags("kyle", [{ flag: "no-area-filters", rep: "kyle", value: false }]).includes("no-area-filters"),
);
t(
  "another rep's row changes nothing",
  JSON.stringify(resolveFlags("kyle", [{ flag: "no-area-filters", rep: "juan", value: true }])) ===
    JSON.stringify(fileDefault),
);
t("* reaches every rep", resolveFlags("juan", [{ flag: "new-thing", rep: "*", value: true }]).includes("new-thing"));
t(
  "the rep's own row beats *",
  !resolveFlags("kyle", [
    { flag: "new-thing", rep: "kyle", value: false },
    { flag: "new-thing", rep: "*", value: true },
  ]).includes("new-thing"),
);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
