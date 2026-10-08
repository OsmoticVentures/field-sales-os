// The offline eval's checks catch the failure modes they name, on made-up
// rows. Run: node --experimental-strip-types tests/evals.test.mts
import { evaluate, type RunRow } from "./evals/checks.mts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};

const row = (task: string, input: string, output: unknown, extra: Partial<RunRow> = {}): RunRow => ({
  task, model: "claude-sonnet-5-5", ok: true, validation: "pass", attempts: 1, fallback_used: false, latency_ms: 4000,
  stop_reason: "end_turn", input_excerpt: input, output_excerpt: JSON.stringify(output), error: null, ...extra,
});
const tp = (over: Record<string, unknown> = {}) => ({
  account_id: null, account_confidence: "high", business_name_guess: "Lassens",
  activity: { kind: "visit", direction: "outbound", outcome: "reached", detail: "I visited Lassens and talked to Maria.", hubspot_summary: "I visited Lassens and talked to Maria." },
  people: [{ first_name: "Maria", last_name: null, title: null, role_tag: "manager", is_decision_maker: true, email: null, phone: null, preferences: "" }],
  calendar_actions: [], directives: [], outreach_asks: [], account_facts: { business_hours: null, phone: null, email: null },
  next_step: "Bring a GSE sample Thursday", ...over,
});
const note = "I visited Lassens and talked to Maria, the manager. Bring a GSE sample Thursday.";
const names = (rows: RunRow[]) => evaluate(rows).failures.map((f) => f.check);

t("a clean touchpoint passes every check", names([row("touchpoint_extract", note, tp())]).length === 0, names([row("touchpoint_extract", note, tp())]));
t("invented person caught", names([row("touchpoint_extract", note, tp({ people: [{ first_name: "Jose", last_name: null, title: null, role_tag: null, is_decision_maker: false, email: null, phone: null, preferences: null }] }))]).includes("invented person"));
t("invented email caught", names([row("touchpoint_extract", note, tp({ account_facts: { business_hours: null, phone: null, email: "orders@lassens.com" } }))]).includes("invented email or phone"));
t("third person caught", names([row("touchpoint_extract", note, tp({ activity: { ...tp().activity, hubspot_summary: "The rep visited Lassens." } }))]).includes("third person in the record"));
t("vague next step caught", names([row("touchpoint_extract", note, tp({ next_step: "Follow up" }))]).includes("vague next step"));
t("buyer by default caught", names([row("touchpoint_extract", "I visited Lassens and talked to Maria.", tp({ people: [{ ...tp().people[0], role_tag: "buyer" }] }))]).includes("buyer by default"));
t("field note claiming a visit caught", names([row("touchpoint_extract", "Note to self: market feels slow", tp({ activity: { ...tp().activity, kind: "field_note", hubspot_summary: "I visited the store." } }))]).includes("field note claims a contact"));
t("off-schema output caught", names([row("touchpoint_extract", note, tp({ activity: { kind: "dance" } }))]).includes("schema"));
t("a failed call counted", names([row("touchpoint_extract", note, null, { ok: false, validation: "error", error: "transient: 529" })]).includes("call failed"));
t("compose: new number caught", names([row("outbound_compose", "send the price sheet", { writable: true, reason: "", contact_id: null, subject: "Price sheet", body: "Hi, 20% off this week." })]).includes("number not in the note"));
t("compose: em dash caught", names([row("outbound_compose", "send the price sheet", { writable: true, reason: "", contact_id: null, subject: "Price sheet", body: "Hi \u2014 here it is." })]).includes("em dash"));
t("odometer letters caught", names([row("mileage_odometer", "Read the odometer.", { reading: "12,3O4" })]).includes("reading not digits"));
t("a clipped output is skipped, not judged", names([row("touchpoint_extract", note, null, { output_excerpt: '{"account_id":null,"activ…' })]).length === 0);

if (failures) {
  console.error(`evals: ${failures} failing`);
  process.exitCode = 1;
} else console.log("evals: all cases pass");
