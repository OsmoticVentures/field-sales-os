import assert from "node:assert/strict";
import { daysNear, dayLabel } from "../src/lib/features/outbound/route-days.ts";
import { openAskFailure } from "../src/lib/features/outbound/gates.ts";

const places = new Map([
  ["glossy", { id: "glossy", city: "Newport Beach", lat: 33.5938, lng: -117.8664 }],
  ["hb", { id: "hb", city: "Huntington Beach", lat: 33.66, lng: -117.99 }],
  ["bak", { id: "bak", city: "Bakersfield", lat: 35.37, lng: -119.02 }],
  ["nocoord", { id: "nocoord", city: "Newport Beach", lat: null, lng: null }],
]);
const target = places.get("glossy")!;

assert.equal(dayLabel("2026-11-18"), "Wednesday, Nov 18");

// A near day counts, a far one does not, custom stops are ignored.
let got = daysNear({ "2026-11-18": ["hb", { id: "custom:lunch" }], "2026-11-19": ["bak"] }, places, target, "2026-11-04");
assert.deepEqual(got.map((d) => d.date), ["2026-11-18"]);
assert.equal(got[0].onRoute, false);

// Too soon to give them time to answer.
assert.deepEqual(daysNear({ "2026-11-05": ["hb"] }, places, target, "2026-11-04"), []);

// A day with the account itself on it outranks an earlier day nearby.
got = daysNear({ "2026-11-10": ["hb"], "2026-11-18": ["glossy"] }, places, target, "2026-11-04");
assert.equal(got[0].date, "2026-11-18");
assert.equal(got[0].onRoute, true);

// No coordinates falls back to the same city.
assert.equal(daysNear({ "2026-11-10": ["nocoord"] }, places, target, "2026-11-04").length, 1);

// The open ask is caught only when he has a day to offer and did not use it.
const open = "I can come back or we can go over them by email, whichever is more convenient for you.";
assert.ok(openAskFailure(open, ["Wednesday, Nov 18"]));
assert.equal(openAskFailure(open, []), null);
assert.equal(openAskFailure("How is Wednesday, Nov 18? Whichever is easier.", ["Wednesday, Nov 18"]), null);
assert.ok(openAskFailure("Is there an afternoon that works for you?", ["Wednesday, Nov 18"]));
assert.equal(openAskFailure("Let me know what order size makes sense.", ["Wednesday, Nov 18"]), null);

console.log("route-days ok");
