import assert from "node:assert/strict";
import { workingDayIso } from "../src/lib/features/route/field-week.ts";

// PDT (UTC-7) in October: 20:59 local is 03:59Z next day, 21:00 is 04:00Z.
assert.equal(workingDayIso(new Date("2026-10-14T03:59:00Z")), "2026-10-13");
assert.equal(workingDayIso(new Date("2026-10-14T04:00:00Z")), "2026-10-14");
assert.equal(workingDayIso(new Date("2026-10-14T16:00:00Z")), "2026-10-14");
// PST (UTC-8) in winter: 21:00 local is 05:00Z.
assert.equal(workingDayIso(new Date("2026-12-01T04:59:00Z")), "2026-11-30");
assert.equal(workingDayIso(new Date("2026-12-01T05:00:00Z")), "2026-12-01");
// Month rollover.
assert.equal(workingDayIso(new Date("2026-11-01T06:30:00Z")), "2026-11-01");
assert.equal(workingDayIso(new Date("2026-11-01T07:30:00Z")), "2026-11-01");
console.log("working-day ok");
