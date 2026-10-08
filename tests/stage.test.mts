// Which deployment this is, and the two staging rails that hang off it:
// HubSpot hard off on staging and every preview, and staging refusing the
// production database. Run: node --experimental-strip-types tests/stage.test.mts
import { readFileSync } from "node:fs";
import {
  assertStagingDatabase,
  hubspotStageRefusal,
  hubspotWritesAllowedHere,
  PRODUCTION_SUPABASE_REF,
  stage,
} from "../src/lib/core/stage.ts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};
const throws = (fn: () => void) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

const PROD = { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" };
const STAGING = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "staging" };
const PREVIEW = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "fix/thing" };
const LOCAL = {};

// stage()
t("production", stage(PROD) === "production");
t("staging branch preview is staging", stage(STAGING) === "staging");
t("other branch preview is preview", stage(PREVIEW) === "preview");
t("no vercel env is local", stage(LOCAL) === "local");
t("development vercel env is local", stage({ VERCEL_ENV: "development" }) === "local");
t("NB_STAGE=staging wins over production", stage({ ...PROD, NB_STAGE: "staging" }) === "staging");
t("NB_STAGE=staging wins locally", stage({ NB_STAGE: "staging" }) === "staging");
t("NB_STAGE other value is ignored", stage({ ...PROD, NB_STAGE: "prod" }) === "production");

// HubSpot hard off
const ON = { NB_HUBSPOT_VISIT_WRITE_ENABLED: "true", NB_HUBSPOT_OUTBOUND_WRITE_ENABLED: "true" };
t("hubspot allowed in production", hubspotWritesAllowedHere({ ...PROD, ...ON }));
t("hubspot allowed locally", hubspotWritesAllowedHere({ ...LOCAL, ...ON }));
t("hubspot off on staging even with flags on", !hubspotWritesAllowedHere({ ...STAGING, ...ON }));
t("hubspot off on preview even with flags on", !hubspotWritesAllowedHere({ ...PREVIEW, ...ON }));
t("hubspot off when NB_STAGE=staging in production", !hubspotWritesAllowedHere({ ...PROD, ...ON, NB_STAGE: "staging" }));
t("no refusal in production", hubspotStageRefusal(PROD) === null);
t("refusal on staging names staging", /staging deployment/.test(hubspotStageRefusal(STAGING) ?? ""));
t("refusal on preview names preview", /preview deployment/.test(hubspotStageRefusal(PREVIEW) ?? ""));

// hubspot.ts keeps asking the stage before any write (it imports server-only,
// so it cannot be loaded here; the wiring is checked at the source).
const src = readFileSync(new URL("../src/lib/features/visit/hubspot.ts", import.meta.url), "utf8");
t("writeEnabled consults hubspotWritesAllowedHere",
  /export const writeEnabled[\s\S]{0,200}hubspotWritesAllowedHere\(\)\s*&&/.test(src));
t("request() refuses a push with the stage reason", /hubspotStageRefusal\(\)/.test(src));

// Production database guard
const PROD_DB = { NB_SUPABASE_URL: `https://${PRODUCTION_SUPABASE_REF}.supabase.co` };
const STAGE_DB = { NB_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" };
t("staging on production db throws", throws(() => assertStagingDatabase({ ...STAGING, ...PROD_DB })));
t("NB_STAGE staging on production db throws", throws(() => assertStagingDatabase({ NB_STAGE: "staging", ...PROD_DB })));
t("staging on its own db starts", !throws(() => assertStagingDatabase({ ...STAGING, ...STAGE_DB })));
t("production on production db starts", !throws(() => assertStagingDatabase({ ...PROD, ...PROD_DB })));
t("preview on production db starts", !throws(() => assertStagingDatabase({ ...PREVIEW, ...PROD_DB })));
t("local on production db starts", !throws(() => assertStagingDatabase({ ...LOCAL, ...PROD_DB })));
t("staging with no db url starts", !throws(() => assertStagingDatabase({ ...STAGING })));

if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
