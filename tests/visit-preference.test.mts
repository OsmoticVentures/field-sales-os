import assert from "node:assert/strict";
import { parseVisitPreference, weekdayOf, laIso, laClockMinutesFromIso, buildWeekPlan } from "../src/lib/features/planner/plan.ts";
import { DEFAULT_PLANNER_OPTIONS } from "../src/lib/features/planner/types.ts";

assert.deepEqual(parseVisitPreference("tue,thu,fri@09:00"), { days: ["tue", "thu", "fri"], time: "09:00" });
assert.deepEqual(parseVisitPreference(null), { days: null, time: null });
assert.equal(weekdayOf("2026-11-24"), "tue");
assert.equal(laClockMinutesFromIso(laIso("2026-11-24", "09:00")), 540);

const home = { lat: 34.0, lng: -118.2, label: "h", address: "h" };
const acct = { id: "a", name: "NHC", lat: 34.2, lng: -118.3, businessHours: null, visitPreference: "tue,thu,fri@09:00", reason: "", score: 90 };
const out = buildWeekPlan({
  days: ["2026-11-23", "2026-11-24"].map((date) => ({ date, start: home, end: home })),
  accountsById: new Map([["a", acct]]), candidates: [acct], anchors: [], usedAccountIds: new Set(),
  legMinutes: () => ({ minutes: 20, estimated: false }), options: DEFAULT_PLANNER_OPTIONS,
} as never);
const monday = out.days.find((d) => d.date === "2026-11-23")!;
const tuesday = out.days.find((d) => d.date === "2026-11-24")!;
assert.equal(monday.stops.length, 0);
assert.equal(tuesday.stops[0].arrive, "09:00");
console.log("visit-preference ok");
