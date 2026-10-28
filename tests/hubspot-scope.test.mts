// The owner verdict behind every HubSpot filing (src/lib/features/visit/
// hubspot-scope.ts). A company merged in the portal must resolve to its
// survivor and pass when the survivor is the rep's, never read as unowned.
// Run: node --experimental-strip-types tests/hubspot-scope.test.mts
import { scopeVerdict } from "../src/lib/features/visit/hubspot-scope.ts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};

const KYLE = "35219013";
const JUAN = "36242368";

// Riffey Chiropractic, as the portal answered on 2026-10-28: the stored id
// 434457106662 comes back as survivor 443767435468.
const merged = scopeVerdict(["434457106662"], [
  { id: "443767435468", properties: { hubspot_owner_id: KYLE, hs_merged_object_ids: "435585533142;434457106662" } },
], KYLE);
t("merged company passes on its survivor's owner", merged.allowed.includes("434457106662"), merged);
t("merged company files to the survivor", merged.survivor["434457106662"] === "443767435468", merged);

const plain = scopeVerdict(["1"], [{ id: "1", properties: { hubspot_owner_id: KYLE } }], KYLE);
t("unmerged company resolves to itself", plain.allowed[0] === "1" && plain.survivor["1"] === "1", plain);

const other = scopeVerdict(["434457106662"], [
  { id: "443767435468", properties: { hubspot_owner_id: JUAN, hs_merged_object_ids: "434457106662" } },
], KYLE);
t("merged into another rep's company is dropped", other.allowed.length === 0 && other.dropped[0]?.owner === JUAN, other);

const gone = scopeVerdict(["999"], [], KYLE);
t("deleted company is dropped, no survivor", gone.allowed.length === 0 && !gone.survivor["999"], gone);

const unowned = scopeVerdict(["2"], [{ id: "2", properties: { hubspot_owner_id: "" } }], KYLE);
t("unowned company is dropped", unowned.allowed.length === 0, unowned);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
