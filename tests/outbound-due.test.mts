import assert from "node:assert/strict";
import { businessDaysLate, dueDay, dueLabel } from "../src/lib/features/outbound/due.ts";

// Thursday afternoon in LA is due the next Monday (Fri, Mon).
assert.equal(dueDay("2026-11-12T22:00:00Z"), "2026-11-16");
// Tuesday is due Thursday.
assert.equal(dueDay("2026-11-10T18:00:00Z"), "2026-11-12");
// 8pm PST Friday is still Friday in LA: due Tuesday.
assert.equal(dueDay("2026-11-14T04:00:00Z"), "2026-11-17");
// Weekends are not counted late.
assert.equal(businessDaysLate("2026-11-06", "2026-11-09"), 1);
assert.equal(businessDaysLate("2026-11-12", "2026-11-12"), 0);
assert.deepEqual(dueLabel("2026-11-10T18:00:00Z", "2026-11-12"), { text: "due today", late: false });
assert.deepEqual(dueLabel("2026-11-12T22:00:00Z", "2026-11-12"), { text: "due Mon", late: false });
assert.deepEqual(dueLabel("2026-10-28T18:00:00Z", "2026-11-12"), { text: "9 days late", late: true });
console.log("outbound due ok");
