import assert from "node:assert/strict";
import { angleField, statesCardFact } from "../src/lib/features/prospect/angle.ts";
import { orderWindowLabel, summarizePurchases } from "../src/lib/features/prospect/purchases.ts";
import { looksLikeTestFiling } from "../src/lib/features/visit/test-filing.ts";

// The Angle that contradicted Spice of Life's card (2026-10-23) renders absent.
const spice = "Spice of Life is a dormant clinic account with just 2 orders totaling $188 lifetime revenue, last ordered Mar 16, 2026.";
assert.equal(angleField(spice), null);
assert.ok(statesCardFact("Reorder was due Jul 25, 2026 and is 51 days overdue."));
assert.ok(statesCardFact("With zero orders on record despite the store being open."));
// A read the card cannot show stands, meeting dates included.
const real = "Juan met on Aug 27, 2026 with Noah, the manager, and the owner is reachable by email.";
assert.equal(angleField(real), real);
assert.equal(statesCardFact("Their site pushes an active merchandising calendar."), false);

// Literature is not a purchase; the count says the window it covers.
const s = summarizePurchases(
  [
    { id: "o2", ordered_at: "2026-03-16", revenue_cents: 9994 },
    { id: "o1", ordered_at: "2024-11-04", revenue_cents: 8835 },
  ],
  [
    { order_id: "o2", product_name: "NutriBiotic Wholesale Order Form", qty: 3, line_revenue_cents: 0, general_category: "Literature" },
    { order_id: "o2", product_name: "Skin Ointment .5 oz.", qty: 1, line_revenue_cents: 499, general_category: "Body Care" },
    { order_id: "o1", product_name: "Skin Ointment .5 oz.", qty: 2, line_revenue_cents: 998, general_category: "Body Care" },
  ],
);
assert.ok(s);
assert.deepEqual([...s.topItems, ...s.smallItems].map((i) => i.name), ["Skin Ointment .5 oz."]);
assert.equal(s.topItems[0].last, "2026-03-16");
assert.equal(orderWindowLabel(s), "2 orders since Nov 2024");

// Test filings are refused; real notes that say "test" or "prove" are not.
assert.ok(looksLikeTestFiling("This is OS TEST 2 - verifying the split HubSpot write flags actually reach HubSpot now."));
assert.ok(looksLikeTestFiling("purely to prove the field-sales-os write path lands in HubSpot"));
assert.ok(looksLikeTestFiling("Will delete from HubSpot and the OS as soon as filing is confirmed."));
assert.equal(looksLikeTestFiling("I left Zack with the Clarity Plus and two testers."), false);
assert.equal(looksLikeTestFiling("They asked for data to prove that our product actually moves."), false);
assert.equal(looksLikeTestFiling("I gave her Clarity Plus to test, she likes it."), false);
console.log("account-panel ok");
