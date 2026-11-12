import assert from "node:assert/strict";
import { fabricationFailure } from "../src/lib/features/outbound/gates.ts";

const phrases = ["10am", "1pm", "30 minutes", "5 minutes"];
const sources = ["She asked about a training for the team. Wednesday, Nov 18"];
const ok = (body: string) => fabricationFailure("Training", body, sources, ["Ana"], phrases);

// His own phrases pass, in his spellings.
assert.equal(ok("Hi Ana,\n\nHow is Wednesday, Nov 18 at 10am?"), null);
assert.equal(ok("Hi Ana,\n\nHow is Wednesday, Nov 18 at 10 AM?"), null);
assert.equal(ok("Hi Ana,\n\nHow is Wednesday, Nov 18 at 1pm? No longer than 30 minutes."), null);
assert.equal(ok("Hi Ana,\n\nCould I come in for 5 minutes on Wednesday, Nov 18?"), null);

// The same digits in any other shape are still invented numbers.
assert.match(ok("Hi Ana,\n\nHow is Wednesday, Nov 18 at 11am?") ?? "", /11/);
assert.match(ok("Hi Ana,\n\nHow is Wednesday, Nov 18 at 10:30am?") ?? "", /10/);
assert.match(ok("Hi Ana,\n\nOrder 10 units and get 30% off.") ?? "", /10/);
assert.match(ok("Hi Ana,\n\nHow is Wednesday, Nov 18 for 15 minutes?") ?? "", /15/);
assert.match(ok("Hi Ana,\n\nWe can meet at 1pm, it costs $5.") ?? "", /5/);

// Without the list, nothing changes.
assert.match(fabricationFailure("T", "Hi Ana,\n\nAt 10am?", sources, ["Ana"]) ?? "", /10/);

console.log("meeting-phrases: ok");
