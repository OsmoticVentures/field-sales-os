// The shared AI client (src/lib/core/ai/core.ts) against a fake model: the
// retry budget, the fallback, schema validation with one corrective retry,
// and the run record. No network, no spend.
// Run: node --experimental-strip-types tests/ai-client.test.mts
import { z } from "zod";
import { AiError, MODELS, TASKS, TIERS, backoffMs, classifyError, runAi, validate, type Deps, type RunRecord } from "../src/lib/core/ai/core.ts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};

type Params = Record<string, unknown> & { model: string; max_tokens: number; messages: unknown[]; output_config?: { effort?: string; format?: { schema: unknown } }; system?: unknown };
type Step = { text?: string; stop?: string; throw?: unknown };

function apiError(status: number, message = `HTTP ${status}`, headers?: Record<string, string>) {
  return Object.assign(new Error(message), { status, name: "APIError", headers });
}

/** A fake messages.create that plays a script, one step per call. */
function fake(steps: Step[]) {
  const calls: Params[] = [];
  const logs: RunRecord[] = [];
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const deps: Deps = {
    create: async (params) => {
      calls.push(JSON.parse(JSON.stringify(params)) as Params);
      const s = steps[calls.length - 1] ?? { text: "{}" };
      if (s.throw) throw s.throw;
      return {
        id: "msg",
        type: "message",
        role: "assistant",
        model: params.model,
        stop_reason: s.stop ?? "end_turn",
        stop_sequence: null,
        content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: s.text ?? "", citations: null }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 0 },
      } as never;
    },
    log: async (r) => {
      logs.push(r);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  };
  return { deps, calls, logs, sleeps };
}

const Schema = z.object({
  kind: z.enum(["visit", "call"]),
  name: z.string().nullable(),
});
const good = JSON.stringify({ kind: "visit", name: null });
const base = { task: "touchpoint_extract" as const, system: "sys", messages: [{ role: "user" as const, content: "I visited Lassens" }], schema: Schema, actor: "juan" };

// config sanity
t("every tier names known models", Object.values(TIERS).every((x) => x.primary in MODELS && x.fallback in MODELS));
t("every task names a tier", Object.values(TASKS).every((x) => x.tier in TIERS));
t("no dated model ids", Object.keys(MODELS).every((m) => !/\d{8}$/.test(m)));

{
  const f = fake([{ text: good }]);
  const r = await runAi(f.deps, base);
  t("valid reply returns parsed data", r.data.kind === "visit" && r.data.name === null);
  t("primary model first", f.calls[0].model === TIERS.standard.primary && !r.fallbackUsed);
  t("effort sent to a model that takes it", f.calls[0].output_config?.effort === "low");
  const schema = f.calls[0].output_config?.format?.schema as { additionalProperties?: boolean; required?: string[] };
  t("structured output schema sent, closed", schema?.additionalProperties === false && schema.required?.includes("name") === true);
  t("one pass record", f.logs.length === 1 && f.logs[0].ok && f.logs[0].validation === "pass" && f.logs[0].attempts === 1);
  t("record carries tokens and actor", f.logs[0].input_tokens === 10 && f.logs[0].cache_read_tokens === 2 && f.logs[0].actor === "juan");
  t("record hashes input, clips excerpt", f.logs[0].input_hash.length === 32 && f.logs[0].input_excerpt === "I visited Lassens");
}

{
  const f = fake([{ throw: apiError(529, "Overloaded") }, { text: good }]);
  const r = await runAi(f.deps, base);
  t("overloaded primary goes to fallback", f.calls[1].model === TIERS.standard.fallback && r.fallbackUsed && r.attempts === 2);
  t("fallback recorded", f.logs[0].fallback_used && f.logs[0].model === TIERS.standard.fallback);
}

{
  const f = fake([{ throw: apiError(429, "rate", { "retry-after": "2" }) }, { text: good }]);
  const r = await runAi(f.deps, base);
  t("429 retries the same model", f.calls[1].model === TIERS.standard.primary && r.attempts === 2);
  t("429 waits what the server asked", f.sleeps[0] >= 2000);
}

{
  const f = fake([{ throw: apiError(500) }, { throw: apiError(503) }, { text: good }]);
  const r = await runAi(f.deps, base);
  t("two 5xx on primary, third try on fallback", f.calls.length === 3 && f.calls[2].model === TIERS.standard.fallback && r.data.kind === "visit");
}

{
  const f = fake([{ throw: apiError(500) }, { throw: apiError(500) }, { throw: apiError(500) }, { text: good }]);
  let err: unknown = null;
  try {
    await runAi(f.deps, base);
  } catch (e) {
    err = e;
  }
  t("budget is three attempts, then AiError", err instanceof AiError && f.calls.length === 3 && (err as AiError).kind === "transient");
  t("failure is recorded", f.logs.length === 1 && !f.logs[0].ok && f.logs[0].validation === "error");
}

{
  const f = fake([{ throw: apiError(400, "bad request") }, { text: good }]);
  let err: unknown = null;
  try {
    await runAi(f.deps, base);
  } catch (e) {
    err = e;
  }
  t("400 fails fast, one attempt", err instanceof AiError && (err as AiError).kind === "permanent" && f.calls.length === 1);
}

{
  const f = fake([{ throw: apiError(401, "auth") }]);
  let err: unknown = null;
  try {
    await runAi(f.deps, base);
  } catch (e) {
    err = e;
  }
  t("401 fails fast", err instanceof AiError && f.calls.length === 1 && f.sleeps.length === 0);
}

{
  const f = fake([{ throw: apiError(404, "model not found") }, { text: good }]);
  const r = await runAi(f.deps, base);
  t("unknown primary model falls back", r.fallbackUsed && f.calls[1].model === TIERS.standard.fallback);
}

{
  const conn = Object.assign(new Error("socket hang up"), { name: "APIConnectionError" });
  const f = fake([{ throw: conn }, { text: good }]);
  const r = await runAi(f.deps, base);
  t("dropped connection retried", r.attempts === 2);
}

{
  const to = Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
  const f = fake([{ throw: to }, { text: good }]);
  let err: unknown = null;
  try {
    await runAi(f.deps, base);
  } catch (e) {
    err = e;
  }
  t("a timeout spent the deadline: no retry", err instanceof AiError && (err as AiError).kind === "timeout" && f.calls.length === 1);
}

{
  const f = fake([{ text: "not json" }, { text: good }]);
  const r = await runAi(f.deps, base);
  const second = f.calls[1].messages as { role: string; content: string }[];
  t("malformed reply gets one corrective retry", r.attempts === 2 && second.length === 2 && /could not be used/.test(second[1].content));
  t("corrective retry keeps the original turn first", second[0].content === "I visited Lassens");
}

{
  const f = fake([{ text: JSON.stringify({ kind: "meeting", name: 3 }) }, { text: JSON.stringify({ kind: "nope" }) }]);
  let err: unknown = null;
  try {
    await runAi(f.deps, base);
  } catch (e) {
    err = e;
  }
  t("schema miss twice is a caught error, not data", err instanceof AiError && (err as AiError).kind === "invalid" && f.calls.length === 2);
  t("schema miss recorded as fail with the output", f.logs[0].validation === "fail" && (f.logs[0].output_excerpt ?? "").includes("nope"));
}

{
  const f = fake([{ text: '{"kind":"vis', stop: "max_tokens" }, { text: good }]);
  const r = await runAi(f.deps, base);
  t("cut-off reply retried with a bigger cap", r.attempts === 2 && f.calls[1].max_tokens === f.calls[0].max_tokens * 2);
}

{
  const f = fake([{ text: "", stop: "refusal" }, { text: good }]);
  const r = await runAi(f.deps, base);
  t("refusal moves to the fallback", r.fallbackUsed && r.data.kind === "visit");
}

{
  const f = fake([{ throw: apiError(529) }, { text: good }]);
  await runAi(f.deps, { ...base, task: "search_suggest_categories" });
  t("fast tier falls back to a model with no effort param", f.calls[1].model === "claude-haiku-4-5" && f.calls[1].output_config?.effort === undefined);
}

{
  const f = fake([{ throw: apiError(500) }, { text: good }]);
  let err: unknown = null;
  try {
    await runAi(f.deps, { ...base, deadline: 1_000_000 + 1_000 });
  } catch (e) {
    err = e;
  }
  t("no retry past the caller's deadline", err instanceof AiError && f.calls.length === 1);
}

{
  const f = fake([{ text: "Hannah Hunt owns it." }]);
  const r = await runAi(f.deps, { task: "enrich_websearch", system: { cached: "stable rules", tail: "now: x" }, messages: [{ role: "user", content: "q" }] });
  const sys = f.calls[0].system as { text: string; cache_control?: unknown }[];
  t("text call returns the text", r.data === "Hannah Hunt owns it." && f.calls[0].output_config?.format === undefined);
  t("stable system part is cached, the tail is not", Array.isArray(sys) && Boolean(sys[0].cache_control) && !sys[1].cache_control);
  t("text call recorded as text", f.logs[0].validation === "text");
}

{
  const f = fake([{ text: good }]);
  f.deps.log = async () => {
    throw new Error("db down");
  };
  const r = await runAi(f.deps, base);
  t("a failing run log never fails the step", r.data.kind === "visit");
}

// pure helpers
t("classify 529 as fallback", classifyError(apiError(529)).retry === "fallback");
t("classify 422 as permanent", classifyError(apiError(422)).retry === "never");
t("classify a plain bug as never", classifyError(new TypeError("x is undefined")).retry === "never");
t("backoff grows", backoffMs(1, undefined, () => 0) < backoffMs(3, undefined, () => 0));
t("validate rejects cut-off", !validate(Schema, good, "max_tokens").ok);

if (failures) {
  console.error(`ai-client: ${failures} failing`);
  process.exitCode = 1;
} else console.log("ai-client: all cases pass");
