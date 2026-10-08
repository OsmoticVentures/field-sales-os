// The daily AI spend cap (src/lib/core/ai/core.ts): the price math, the
// pre-call estimate, the reserve-then-settle wiring in runAi, failing closed,
// and race safety across concurrent calls. A fake model and a fake ledger
// that mirrors nb_ai_spend_reserve's conditional UPDATE. No network, no spend.
// The same race against the real database: tests/ai-spend-race.live.mts.
// Run: node --experimental-strip-types tests/ai-spend.test.mts
import { z } from "zod";
import {
  AI_CAP_MESSAGE,
  AI_CAP_STATUS,
  AI_DAILY_CAP_USD,
  AI_LEDGER_DOWN_MESSAGE,
  AiError,
  ESTIMATE,
  MODELS,
  PRICES,
  TIERS,
  WEB_SEARCH_USD,
  costUsd,
  estimateUsd,
  isAiCap,
  runAi,
  type Budget,
  type Deps,
  type RunRecord,
  type SpendTicket,
} from "../src/lib/core/ai/core.ts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

// ---------------------------------------------------------------------------
// the math
// ---------------------------------------------------------------------------

t("the cap is one number, $5 a day", AI_DAILY_CAP_USD === 5);
t("the cap's route status is one no phone queue re-sends", AI_CAP_STATUS === 409);
t("every model has a price", Object.keys(MODELS).every((m) => m in PRICES));

t(
  "Sonnet 5.5: input, cache write, cache read and output each at their own rate",
  near(costUsd("claude-sonnet-5-5", { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100, webSearches: 0 }), (1000 * 2 + 100 * 2.5 + 2000 * 0.1 + 500 * 10) / 1e6),
);
t("Sonnet 5 cache reads at $0.20, not 5.5's $0.10", near(costUsd("claude-sonnet-5", { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0, webSearches: 0 }), 0.2));
t("Haiku 5.5 at 100K prompt tokens: the low rates", near(costUsd("claude-haiku-5-5", { input: 100_000, output: 1000, cacheRead: 0, cacheWrite: 0, webSearches: 0 }), (100_000 * 0.1 + 1000 * 0.5) / 1e6));
t(
  "Haiku 5.5 over 100K (cache included): every token at the high rates",
  near(costUsd("claude-haiku-5-5", { input: 90_000, output: 1000, cacheRead: 10_001, cacheWrite: 0, webSearches: 0 }), Math.round(90_000 * 0.5 + 10_001 * 0.05 + 1000 * 2.5) / 1e6),
);
t("a web search adds $0.01", near(costUsd("claude-haiku-4-5", { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 3 }), 3 * WEB_SEARCH_USD));
t("cost is rounded to the micro-dollar", Number.isInteger(costUsd("claude-sonnet-5-5", { input: 7, output: 3, cacheRead: 1, cacheWrite: 1, webSearches: 0 }) * 1e6));

// the estimate is a ceiling: the largest reply the call is allowed, at the dearest input rate
{
  const text = "x".repeat(9000);
  const params = { system: "s".repeat(300), messages: [{ role: "user" as const, content: text }], max_tokens: 8000 };
  const est = estimateUsd("claude-sonnet-5-5", params);
  const inTok = Math.ceil(9300 / ESTIMATE.charsPerToken) + ESTIMATE.overheadTokens;
  t("estimate: chars/3 at the cache-write rate plus the full max_tokens", near(est, (inTok * 2.5 + 8000 * 10) / 1e6), est);
  // a real reply to that call: ~4 chars a token, a fraction of max_tokens
  const real = costUsd("claude-sonnet-5-5", { input: 2400, output: 1500, cacheRead: 0, cacheWrite: 0, webSearches: 0 });
  t("estimate stays above a realistic real cost", est > real, { est, real });
  const withImage = estimateUsd("claude-sonnet-5-5", {
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }, { type: "text", text: "Read it." }] }],
    max_tokens: 2000,
  });
  t("an image counts as the largest image", withImage >= (ESTIMATE.imageTokens * 2.5 + 2000 * 10) / 1e6);
  const search = estimateUsd("claude-sonnet-5-5", { messages: [{ role: "user", content: "Business: X" }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }], max_tokens: 4000 });
  t("a web search tool reserves every allowed search and its results", search >= 3 * WEB_SEARCH_USD + (3 * ESTIMATE.searchTokens * 2.5) / 1e6 + (4000 * 10) / 1e6);
  t("Haiku 5.5 estimate switches to the high rates past 100K", estimateUsd("claude-haiku-5-5", { messages: [{ role: "user", content: "y".repeat(330_000) }], max_tokens: 1000 }) > (110_000 * 0.625) / 1e6);
}

// ---------------------------------------------------------------------------
// runAi with a budget
// ---------------------------------------------------------------------------

type Step = { text?: string; stop?: string; throw?: unknown; usage?: Partial<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; web: number }> };

function apiError(status: number, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status, name: "APIError" });
}

/** A ledger that does what nb_ai_spend_reserve does: one atomic
 *  compare-and-add on the day's row. `gap` puts an await between the
 *  request and the answer, as the network does. */
function atomicLedger(cap: number, gap = async () => {}) {
  const day = { spent: 0, reserved: 0, peakHeld: 0, blocked: 0, settles: [] as { held: number; actual: number }[] };
  const budget: Budget = {
    reserve: async (usd) => {
      await gap();
      if (day.spent + day.reserved + usd <= cap + 1e-12) {
        day.reserved += usd;
        day.peakHeld = Math.max(day.peakHeld, day.spent + day.reserved);
        return { ok: true, ticket: { day: "2026-10-08", usd } };
      }
      day.blocked += 1;
      return { ok: false, reason: "cap" };
    },
    settle: async (ticket: SpendTicket, actual) => {
      await gap();
      day.reserved = Math.max(0, day.reserved - ticket.usd);
      day.spent += actual;
      day.settles.push({ held: ticket.usd, actual });
    },
  };
  return { budget, day };
}

function fake(steps: Step[], budget?: Budget) {
  const calls: { model: string; max_tokens: number }[] = [];
  const logs: RunRecord[] = [];
  let clock = 1_000_000;
  const deps: Deps = {
    create: async (params) => {
      calls.push({ model: params.model, max_tokens: params.max_tokens });
      const s = steps[calls.length - 1] ?? { text: "{}" };
      if (s.throw) throw s.throw;
      const u = s.usage ?? {};
      return {
        id: "msg",
        type: "message",
        role: "assistant",
        model: params.model,
        stop_reason: s.stop ?? "end_turn",
        stop_sequence: null,
        content: [{ type: "text", text: s.text ?? "", citations: null }],
        usage: {
          input_tokens: u.input_tokens ?? 1000,
          output_tokens: u.output_tokens ?? 200,
          cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
          server_tool_use: u.web ? { web_search_requests: u.web, web_fetch_requests: 0 } : null,
        },
      } as never;
    },
    log: async (r) => {
      logs.push(r);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    budget,
  };
  return { deps, calls, logs };
}

const Schema = z.object({ kind: z.enum(["visit", "call"]) });
const good = JSON.stringify({ kind: "visit" });
const base = { task: "touchpoint_extract" as const, system: "sys", messages: [{ role: "user" as const, content: "I visited Lassens" }], schema: Schema, actor: "juan" };

{
  const L = atomicLedger(5);
  const f = fake([{ text: good, usage: { input_tokens: 3000, output_tokens: 900 } }], L.budget);
  await runAi(f.deps, base);
  const expected = costUsd(TIERS.standard.primary, { input: 3000, output: 900, cacheRead: 0, cacheWrite: 0, webSearches: 0 });
  t("a call settles its real cost, and the hold comes off", near(L.day.spent, expected) && near(L.day.reserved, 0) && L.day.settles.length === 1);
  t("the run record carries the cost", near(f.logs[0].cost_usd, expected), f.logs[0].cost_usd);
  t("the hold was the estimate, above the real cost", L.day.settles[0].held > expected);
}

{
  // every attempt reserves: an invalid reply and its corrective retry are two calls, two holds
  const L = atomicLedger(5);
  const f = fake([{ text: "not json" }, { text: good }], L.budget);
  await runAi(f.deps, base);
  t("a retry is a call: reserved and settled again", L.day.settles.length === 2 && f.calls.length === 2);
  t("the record sums both attempts' cost", near(f.logs[0].cost_usd, L.day.spent));
}

{
  // an overloaded primary, then the fallback: each attempt priced at its own model
  const L = atomicLedger(5);
  const f = fake([{ throw: apiError(529, "overloaded") }, { text: good, usage: { input_tokens: 1000, output_tokens: 100 } }], L.budget);
  const r = await runAi(f.deps, base);
  t("an error answer settles at zero", L.day.settles[0].actual === 0);
  t("the fallback's attempt is priced at the fallback model", r.fallbackUsed && near(L.day.settles[1].actual, costUsd(TIERS.standard.fallback, { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, webSearches: 0 })));
}

{
  // a timeout may have been billed: it keeps its whole hold as spend
  const L = atomicLedger(5);
  const f = fake([{ throw: Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" }) }], L.budget);
  await runAi(f.deps, base).catch(() => null);
  t("a timeout counts its whole estimate as spent", L.day.settles.length === 1 && near(L.day.settles[0].actual, L.day.settles[0].held) && L.day.spent > 0);
}

{
  // web searches are priced
  const L = atomicLedger(5);
  const f = fake([{ text: "found it", usage: { input_tokens: 5000, output_tokens: 300, web: 2 } }], L.budget);
  await runAi(f.deps, { task: "enrich_websearch", system: "s", messages: [{ role: "user", content: "Business: X" }], tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }] });
  t("two searches add $0.02 to the call", near(L.day.spent, costUsd(TIERS.standard.primary, { input: 5000, output: 300, cacheRead: 0, cacheWrite: 0, webSearches: 2 })) && L.day.spent > 0.02);
}

{
  // the cap: no call is made, the error is plain, nothing is held
  const L = atomicLedger(0.01);
  const f = fake([{ text: good }], L.budget);
  let err: unknown = null;
  await runAi(f.deps, base).catch((e) => (err = e));
  t("over the cap: the model is never called", f.calls.length === 0);
  t("over the cap: AiError kind cap with the plain sentence", isAiCap(err) && (err as AiError).message === AI_CAP_MESSAGE);
  t("the plain sentence", AI_CAP_MESSAGE === "Today's AI limit is reached. Try again tomorrow.");
  t("over the cap: one failed run record, zero cost, zero attempts", f.logs.length === 1 && !f.logs[0].ok && f.logs[0].cost_usd === 0 && f.logs[0].attempts === 0);
  t("over the cap: nothing held, nothing spent", L.day.reserved === 0 && L.day.spent === 0 && L.day.blocked === 1);
}

{
  // the cap lands mid-step: the first attempt ran, the correction may not
  const L = atomicLedger(0);
  let n = 0;
  const budget: Budget = {
    reserve: async (usd) => (n++ === 0 ? { ok: true, ticket: { day: "d", usd } } : { ok: false, reason: "cap" }),
    settle: L.budget.settle,
  };
  const f = fake([{ text: "not json" }, { text: good }], budget);
  let err: unknown = null;
  await runAi(f.deps, base).catch((e) => (err = e));
  t("cap between attempts: the retry is not made, the step fails with the cap", f.calls.length === 1 && isAiCap(err));
}

{
  // fails closed: an unreachable counter, or one that throws, stops the call
  for (const budget of [
    { reserve: async () => ({ ok: false as const, reason: "unavailable" as const }), settle: async () => {} },
    { reserve: async () => { throw new Error("ECONNRESET"); }, settle: async () => {} },
  ] satisfies Budget[]) {
    const f = fake([{ text: good }], budget);
    let err: unknown = null;
    await runAi(f.deps, base).catch((e) => (err = e));
    t("counter down: no call, the step says so", f.calls.length === 0 && isAiCap(err) && (err as AiError).message === AI_LEDGER_DOWN_MESSAGE);
  }
}

{
  // a settle that fails never fails the step
  const f = fake([{ text: good }], { reserve: async (usd) => ({ ok: true, ticket: { day: "d", usd } }), settle: async () => { throw new Error("down"); } });
  const r = await runAi(f.deps, base);
  t("a failed settle keeps the answer", r.data.kind === "visit");
}

// ---------------------------------------------------------------------------
// race safety
// ---------------------------------------------------------------------------

{
  // 40 steps at once, each answer arriving in a random order, against a cap
  // that fits only some of them. The held-plus-spent total never passes the cap.
  const rand = (() => {
    let s = 7;
    return () => ((s = (s * 48271) % 2147483647) / 2147483647);
  })();
  const gap = () => new Promise<void>((r) => setTimeout(r, Math.floor(rand() * 4)));
  const est = estimateUsd(TIERS.standard.primary, { system: "sys", messages: base.messages, max_tokens: 8000, output_config: { effort: "low" } });
  const cap = est * 10.5;
  const L = atomicLedger(cap, gap);
  const runs = Array.from({ length: 40 }, () => {
    const f = fake([{ text: good, usage: { input_tokens: 800, output_tokens: 300 } }], L.budget);
    f.deps.create = (async (params: unknown) => {
      await gap();
      return fake([{ text: good, usage: { input_tokens: 800, output_tokens: 300 } }]).deps.create(params as never, { timeout: 1, maxRetries: 0 });
    }) as Deps["create"];
    return runAi(f.deps, { ...base, messages: [{ role: "user" as const, content: "I visited Lassens" }] }).then(
      () => "ok",
      (e) => (isAiCap(e) ? "cap" : "other"),
    );
  });
  const out = await Promise.all(runs);
  t("concurrent: held plus spent never passed the cap", L.day.peakHeld <= cap + 1e-12, { peak: L.day.peakHeld, cap });
  t("concurrent: some ran, the rest were refused plainly", out.includes("ok") && out.includes("cap") && !out.includes("other"), out);
  t("concurrent: day ends with nothing held and spent under the cap", near(L.day.reserved, 0) && L.day.spent <= cap);
}

{
  // Why the counter is one atomic compare-and-add and not "read the total,
  // then add": the read-then-write version, with the network between the two,
  // lets concurrent callers all see room and all pass.
  const cap = 1;
  let spentPlusHeld = 0;
  let peak = 0;
  const naive: Budget = {
    reserve: async (usd) => {
      const seen = spentPlusHeld; // SELECT
      await new Promise((r) => setTimeout(r, 2)); // the round trip
      if (seen + usd > cap) return { ok: false, reason: "cap" };
      spentPlusHeld += usd; // UPDATE
      peak = Math.max(peak, spentPlusHeld);
      return { ok: true, ticket: { day: "d", usd } };
    },
    settle: async () => {},
  };
  await Promise.all(Array.from({ length: 10 }, () => naive.reserve(0.3)));
  const A = atomicLedger(cap, () => new Promise((r) => setTimeout(r, 2)));
  await Promise.all(Array.from({ length: 10 }, () => A.budget.reserve(0.3)));
  t("read-then-write overshoots the cap under concurrency (the bug the SQL avoids)", peak > cap, peak);
  t("the atomic compare-and-add holds 0.90 of a 1.00 cap, no more", near(A.day.peakHeld, 0.9));
}

if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log("ai spend: all passed");
