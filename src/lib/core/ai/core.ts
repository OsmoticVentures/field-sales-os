/**
 * The one way this app asks a model for anything. Every AI step is a fixed,
 * code-controlled workflow (one call, a schema, a check), never an open agent
 * loop, so each step can be made dependable on its own terms:
 *
 *   1. MODELS IN ONE PLACE. Each task names a tier; the tier names a primary
 *      model and a fallback. Changing a model is one line in TIERS.
 *   2. A BOUNDED RETRY BUDGET. At most three attempts and one deadline per
 *      call. Only transient failures are retried (429, 5xx, overloaded, a
 *      dropped connection). A permanent failure (a bad request, a bad key)
 *      fails at once. An overloaded or unknown primary hands the next attempt
 *      to the fallback model.
 *   3. SCHEMA-VALIDATED OUTPUT. A task with a zod schema runs with structured
 *      outputs (output_config.format), and the reply is parsed and validated
 *      here. A reply that does not validate (cut off, refused, malformed)
 *      becomes one corrective retry, then a thrown AiError: never silent bad
 *      data.
 *   4. A RUN RECORD. Every call, pass or fail, hands one record to `log` (the
 *      server wiring writes it to nb_ai_runs for error analysis), with what
 *      it cost in USD.
 *   5. A HARD DAILY CAP. Before every API call, retries included, its cost
 *      ceiling is reserved against the day's total (AI_DAILY_CAP_USD, per
 *      Pacific day, across the whole app). Refused, the call is not made and
 *      an AiError of kind "cap" says so in a sentence a rep can read.
 *
 * PURE ON PURPOSE: no "server-only", no env reads, no relative imports, and
 * the SDK is injected, so tests/ai-client.test.mts runs this file under plain
 * node with a fake model. The server wiring is ./client.ts.
 */
import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { toJSONSchema, type z } from "zod";

// ---------------------------------------------------------------------------
// the config: models, tiers, tasks
// ---------------------------------------------------------------------------

/** Current model ids (checked against the claude-api skill, 2026-10-08). No
 *  date suffixes. `effort` says whether the model takes output_config.effort:
 *  Claude Haiku 4.5 rejects it. */
export const MODELS = {
  "claude-sonnet-5-5": { effort: true },
  "claude-sonnet-5": { effort: true },
  "claude-haiku-5-5": { effort: true },
  "claude-haiku-4-5": { effort: false },
} as const;
export type ModelId = keyof typeof MODELS;

/** standard: reading a note, a page or a photo, and writing in his voice.
 *  fast: a yes/no decision or a short suggestion list. */
export const TIERS = {
  standard: { primary: "claude-sonnet-5-5", fallback: "claude-sonnet-5" },
  fast: { primary: "claude-haiku-5-5", fallback: "claude-haiku-4-5" },
} as const satisfies Record<string, { primary: ModelId; fallback: ModelId }>;
export type Tier = keyof typeof TIERS;

export type Effort = "low" | "medium" | "high";

/** Every AI step in the app. maxTokens covers thinking plus the reply (these
 *  models think by default, and thinking counts against the cap). timeoutMs is
 *  the whole call, retries included; a caller's own deadline can only shorten it. */
export const TASKS = {
  touchpoint_extract: { tier: "standard", effort: "low", maxTokens: 8000, timeoutMs: 40_000 },
  outbound_decide: { tier: "fast", effort: "low", maxTokens: 2000, timeoutMs: 15_000 },
  outbound_compose: { tier: "standard", effort: "low", maxTokens: 6000, timeoutMs: 40_000 },
  enrich_site_people: { tier: "standard", effort: "low", maxTokens: 6000, timeoutMs: 30_000 },
  enrich_websearch: { tier: "standard", effort: "low", maxTokens: 4000, timeoutMs: 35_000 },
  enrich_websearch_extract: { tier: "standard", effort: "low", maxTokens: 4000, timeoutMs: 20_000 },
  prospect_quick_enrich: { tier: "standard", effort: "low", maxTokens: 4000, timeoutMs: 25_000 },
  expenses_classify: { tier: "standard", effort: "low", maxTokens: 3000, timeoutMs: 25_000 },
  mileage_odometer: { tier: "standard", effort: "low", maxTokens: 2000, timeoutMs: 25_000 },
  search_suggest_categories: { tier: "fast", effort: "low", maxTokens: 2000, timeoutMs: 15_000 },
} as const satisfies Record<string, { tier: Tier; effort: Effort; maxTokens: number; timeoutMs: number }>;
export type TaskName = keyof typeof TASKS;

export const MAX_ATTEMPTS = 3;
/** Structured outputs: at most 16 parameters with a union type (anyOf or a
 *  type array, so every nullable field) across a request's schemas. */
export const MAX_UNION_PARAMS = 16;
const MIN_ATTEMPT_MS = 4_000;
const MAX_TOKENS_CEILING = 16_000;

// ---------------------------------------------------------------------------
// spend: the daily cap, the prices, what a call cost and what it may cost
// ---------------------------------------------------------------------------

/** THE CAP: US dollars of AI spend PER DAY, across the whole app (every rep,
 *  every task, together). The day turns over at midnight Pacific
 *  (America/Los_Angeles, in nb_ai_spend_reserve). Change this one number to
 *  move the limit; the next deploy uses it. */
export const AI_DAILY_CAP_USD = 5;

export const AI_CAP_MESSAGE = "Today's AI limit is reached. Try again tomorrow.";
export const AI_LEDGER_DOWN_MESSAGE = "Today's AI spend could not be checked just now. Try again in a minute.";
/** What a route answers when the cap stops a step. 409, because neither
 *  phone queue (writeq-core.ts, outbox-core.ts) re-sends a 409 by itself: the
 *  screen shows the message in red and keeps what he typed. */
export const AI_CAP_STATUS = 409;

/** USD per million tokens, from the Anthropic pricing page (2026-10-08).
 *  cacheWrite is the 5-minute write, the only cache this app writes. */
type Rates = { input: number; cacheWrite: number; cacheRead: number; output: number };
export const PRICES: Record<ModelId, { base: Rates; long?: { overTokens: number; rates: Rates } }> = {
  "claude-sonnet-5-5": { base: { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 } },
  "claude-sonnet-5": { base: { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 } },
  // Claude Haiku 5.5 is priced by prompt length: over 100K tokens, all of it
  // goes at the higher rates.
  "claude-haiku-5-5": {
    base: { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
    long: { overTokens: 100_000, rates: { input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 } },
  },
  "claude-haiku-4-5": { base: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } },
};
/** The web search server tool: $10 per 1,000 searches, on top of tokens. */
export const WEB_SEARCH_USD = 0.01;

export type CallUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; webSearches: number };

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function ratesFor(model: ModelId, promptTokens: number): Rates {
  const p = PRICES[model];
  return p.long && promptTokens > p.long.overTokens ? p.long.rates : p.base;
}

/** What one API call cost, from the usage it reported. */
export function costUsd(model: ModelId, u: CallUsage): number {
  const r = ratesFor(model, u.input + u.cacheRead + u.cacheWrite);
  return round6(
    (u.input * r.input + u.cacheWrite * r.cacheWrite + u.cacheRead * r.cacheRead + u.output * r.output) / 1e6 +
      u.webSearches * WEB_SEARCH_USD,
  );
}

/** The estimate's assumptions, all on the high side: about 3 characters a
 *  token (English runs nearer 4), an image at the largest size these models
 *  read, every allowed search used and each returning a full page of results,
 *  all input billed at the cache-write rate, and the whole max_tokens spent. */
export const ESTIMATE = { charsPerToken: 3, imageTokens: 9_000, searchTokens: 15_000, defaultSearches: 5, overheadTokens: 600 } as const;

/** A conservative ceiling on what one API call can cost, before it is made.
 *  Reserved against the day's cap, then settled to the real cost. */
export function estimateUsd(model: ModelId, params: Pick<CreateParams, "system" | "messages" | "tools" | "max_tokens" | "output_config">): number {
  let chars = 0;
  let images = 0;
  const block = (b: unknown) => {
    const x = b as { type?: string; text?: unknown };
    if (x?.type === "text" && typeof x.text === "string") chars += x.text.length;
    else if (x?.type === "image" || x?.type === "document") images += 1;
    else chars += JSON.stringify(b ?? "").length;
  };
  if (typeof params.system === "string") chars += params.system.length;
  else for (const b of params.system ?? []) block(b);
  for (const m of params.messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else for (const b of m.content) block(b);
  }
  let searches = 0;
  for (const t of params.tools ?? []) {
    chars += JSON.stringify(t).length;
    const tool = t as { type?: string; max_uses?: number };
    if (typeof tool.type === "string" && tool.type.startsWith("web_search")) searches += tool.max_uses ?? ESTIMATE.defaultSearches;
  }
  if (params.output_config?.format) chars += JSON.stringify(params.output_config.format).length;
  const inputTokens =
    Math.ceil(chars / ESTIMATE.charsPerToken) + images * ESTIMATE.imageTokens + searches * ESTIMATE.searchTokens + ESTIMATE.overheadTokens;
  const r = ratesFor(model, inputTokens);
  return round6((inputTokens * Math.max(r.input, r.cacheWrite) + params.max_tokens * r.output) / 1e6 + searches * WEB_SEARCH_USD);
}

/** One reservation against a day's cap: the Pacific day it was taken on and
 *  the amount held. */
export type SpendTicket = { day: string; usd: number };

/** The day's spend counter (server: ./spend-ledger.ts, one row per day in
 *  nb_ai_spend_days). reserve() adds `usd` atomically only while the day's
 *  spent plus reserved plus `usd` stays within `cap`; settle() swaps the held
 *  amount for the real cost. */
export type Budget = {
  reserve: (usd: number) => Promise<{ ok: true; ticket: SpendTicket } | { ok: false; reason: "cap" | "unavailable" }>;
  settle: (ticket: SpendTicket, actualUsd: number) => Promise<void>;
};

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/** "cap": the day's AI spend limit stopped the call before it was made (or
 *  the limit could not be checked, which stops it too). */
export type AiErrorKind = "unconfigured" | "permanent" | "transient" | "timeout" | "invalid" | "refusal" | "cap";

/** What a caller catches. `message` is plain enough to show a rep. */
export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly detail?: string;
  constructor(kind: AiErrorKind, message: string, detail?: string) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    this.detail = detail;
  }
}

/** True when the daily cap (or an unreachable spend counter) stopped the
 *  step: the caller shows `err.message` as it is and saves nothing. */
export function isAiCap(err: unknown): err is AiError {
  return err instanceof AiError && err.kind === "cap";
}

type Failure = { retry: "same" | "fallback" | "never"; kind: AiErrorKind; detail: string; waitMs?: number };

/** Read an SDK error (or anything thrown) into a retry decision. Duck-typed on
 *  `status` and the class name so the fake client in the tests can throw the
 *  same shapes the SDK does. */
export function classifyError(err: unknown): Failure {
  const e = err as { status?: unknown; name?: unknown; message?: unknown; headers?: unknown; error?: unknown };
  const name = typeof e?.name === "string" ? e.name : "";
  const detail = typeof e?.message === "string" ? e.message.slice(0, 300) : String(err).slice(0, 300);
  if (name.includes("Timeout") || /timed? ?out/i.test(detail)) return { retry: "never", kind: "timeout", detail };
  if (name.includes("Connection")) return { retry: "same", kind: "transient", detail };
  const status = typeof e?.status === "number" ? e.status : null;
  if (status === null) {
    // Not an API error at all (a bug, an abort): retrying cannot help.
    return { retry: "never", kind: "permanent", detail };
  }
  if (status === 529 || /overloaded/i.test(detail)) return { retry: "fallback", kind: "transient", detail };
  if (status === 429) return { retry: "same", kind: "transient", detail, waitMs: retryAfterMs(e.headers) };
  if (status === 408 || status === 409 || status >= 500) return { retry: "same", kind: "transient", detail };
  // A model id the account cannot reach: the fallback can still answer.
  if (status === 404) return { retry: "fallback", kind: "permanent", detail };
  return { retry: "never", kind: "permanent", detail };
}

function retryAfterMs(headers: unknown): number | undefined {
  const get = (k: string): string | null => {
    if (!headers) return null;
    if (typeof (headers as Headers).get === "function") return (headers as Headers).get(k);
    const v = (headers as Record<string, unknown>)[k];
    return typeof v === "string" ? v : null;
  };
  const s = Number(get("retry-after"));
  return Number.isFinite(s) && s > 0 ? s * 1000 : undefined;
}

/** 0.5s, 1s, 2s, plus jitter, capped by whatever the server asked for. */
export function backoffMs(attempt: number, serverAskedMs?: number, rand: () => number = Math.random): number {
  const base = 500 * 2 ** Math.max(0, attempt - 1);
  return Math.max(serverAskedMs ?? 0, Math.round(base + rand() * 250));
}

// ---------------------------------------------------------------------------
// the run record
// ---------------------------------------------------------------------------

export type RunRecord = {
  task: TaskName;
  model: string;
  ok: boolean;
  /** "pass" when the reply validated, "fail" when it did not, "error" when no
   *  reply came back at all, "text" for a call with no schema. */
  validation: "pass" | "fail" | "error" | "text";
  attempts: number;
  fallback_used: boolean;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** USD, every attempt priced at the model that answered it (costUsd). */
  cost_usd: number;
  stop_reason: string | null;
  input_hash: string;
  input_excerpt: string;
  output_excerpt: string | null;
  error: string | null;
  actor: string | null;
};

export const EXCERPT_CHARS = { input: 1500, output: 6000 } as const;

export function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Stable hash of what a task was asked: the same input always hashes the same,
 *  so a run can be matched to its retries and to its side effects. */
export function hashInput(...parts: unknown[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(typeof p === "string" ? p : JSON.stringify(p ?? null)).update("\u0000");
  return h.digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// the call
// ---------------------------------------------------------------------------

type CreateParams = Anthropic.MessageCreateParamsNonStreaming;
type Message = Anthropic.Message;

export type Deps = {
  /** client.messages.create, bound, with per-request options. */
  create: (params: CreateParams, opts: { timeout: number; maxRetries: 0 }) => Promise<Message>;
  log?: (rec: RunRecord) => Promise<void>;
  /** The daily cap. Every API call reserves its estimate here first and is
   *  not made when the reservation is refused. Absent only in tests. */
  budget?: Budget;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type AiRequest<S extends z.ZodType | undefined> = {
  task: TaskName;
  /** A plain system prompt, or one split so the stable part is cached (put the
   *  volatile part, a timestamp, in `tail`). */
  system: string | { cached: string; tail?: string };
  messages: Anthropic.MessageParam[];
  schema?: S;
  /** Server tools for a text call (web search). Never combined with a schema. */
  tools?: Anthropic.ToolUnion[];
  /** An absolute epoch-ms deadline from the caller's own time budget. */
  deadline?: number;
  /** Who asked (the rep id), for the run record. */
  actor?: string | null;
};

export type AiResult<T> = {
  data: T;
  /** Every text block, joined: the whole answer of a text call. */
  text: string;
  /** The final message, for a caller that reads more than text (citations). */
  message: Message;
  model: string;
  attempts: number;
  fallbackUsed: boolean;
};

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number };

function systemParam(system: AiRequest<undefined>["system"], extra?: string): CreateParams["system"] {
  if (typeof system === "string" && !extra) return system;
  const blocks: Anthropic.TextBlockParam[] =
    typeof system === "string"
      ? [{ type: "text", text: system }]
      : [{ type: "text", text: system.cached, cache_control: { type: "ephemeral" } }];
  if (typeof system !== "string" && system.tail) blocks.push({ type: "text", text: system.tail });
  if (extra) blocks.push({ type: "text", text: extra });
  return blocks;
}

function promptSchemaLine(schema: Json): string {
  return `Answer with only one JSON object, no other text, matching this JSON schema exactly (every field present; null where the schema allows it and the text states nothing):\n${JSON.stringify(schema)}`;
}

/** A 400 that names the output schema: the grammar could not be built. */
function isSchemaRejection(err: unknown): boolean {
  const e = err as { status?: unknown; message?: unknown };
  return e?.status === 400 && typeof e.message === "string" && /schema|output_config|format|grammar|compil/i.test(e.message);
}

function inputExcerpt(req: AiRequest<z.ZodType | undefined>): string {
  const parts: string[] = [];
  for (const m of req.messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") parts.push(m.content);
    else for (const b of m.content) if (b.type === "text") parts.push(b.text);
      else if (b.type === "image") parts.push("[image]");
  }
  return clip(parts.join("\n\n"), EXCERPT_CHARS.input);
}

function hashOfRequest(req: AiRequest<z.ZodType | undefined>): string {
  const msgs = req.messages.map((m) =>
    typeof m.content === "string"
      ? m.content
      : m.content.map((b) =>
          b.type === "text" ? b.text : b.type === "image" && b.source.type === "base64" ? hashInput(b.source.data) : b.type,
        ),
  );
  return hashInput(req.task, req.system, msgs);
}

/**
 * Run one task. Returns validated data (or the text, for a call with no
 * schema), or throws an AiError after the budget is spent.
 */
export async function runAi<S extends z.ZodType | undefined = undefined>(
  deps: Deps,
  req: AiRequest<S>,
): Promise<AiResult<S extends z.ZodType ? z.infer<S> : string>> {
  type Out = S extends z.ZodType ? z.infer<S> : string;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cfg = TASKS[req.task];
  const tier = TIERS[cfg.tier];
  const started = now();
  const deadline = Math.min(started + cfg.timeoutMs, req.deadline ?? Infinity);
  const format = req.schema ? { schema: strictJsonSchema(req.schema) } : null;
  // Grammar mode (structured outputs) when the schema fits the API's limits;
  // otherwise, or when the API rejects the schema, the same schema goes in
  // the prompt and zod alone holds the reply to it. Either way the reply is
  // validated below, so a rejected schema costs one attempt, not the step.
  let jsonMode: "grammar" | "prompt" | null = format ? (unionCount(format.schema) <= MAX_UNION_PARAMS ? "grammar" : "prompt") : null;

  let model: ModelId = tier.primary;
  let maxTokens: number = cfg.maxTokens;
  let messages = req.messages;
  let attempts = 0;
  let fallbackUsed = false;
  let correctedOnce = false;
  let lastStop: string | null = null;
  let lastText: string | null = null;
  let lastError: AiError | null = null;
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

  const toFallback = (): boolean => {
    if (fallbackUsed) return false;
    model = tier.fallback;
    fallbackUsed = true;
    return true;
  };

  const record = async (ok: boolean, validation: RunRecord["validation"], error: string | null) => {
    if (!deps.log) return;
    try {
      await deps.log({
        task: req.task,
        model,
        ok,
        validation,
        attempts,
        fallback_used: fallbackUsed,
        latency_ms: now() - started,
        input_tokens: usage.input,
        output_tokens: usage.output,
        cache_read_tokens: usage.cacheRead,
        cache_write_tokens: usage.cacheWrite,
        cost_usd: round6(usage.costUsd),
        stop_reason: lastStop,
        input_hash: hashOfRequest(req),
        input_excerpt: inputExcerpt(req),
        output_excerpt: lastText === null ? null : clip(lastText, EXCERPT_CHARS.output),
        error: error ? clip(error, 500) : null,
        actor: req.actor ?? null,
      });
    } catch {
      // A run record is for analysis; it never fails the step it describes.
    }
  };

  while (attempts < MAX_ATTEMPTS) {
    const remaining = deadline - now();
    if (remaining < MIN_ATTEMPT_MS && attempts > 0) break;
    attempts += 1;

    const params: CreateParams = {
      model,
      max_tokens: maxTokens,
      system: systemParam(req.system, jsonMode === "prompt" && format ? promptSchemaLine(format.schema) : undefined),
      messages,
      ...(req.tools ? { tools: req.tools } : {}),
    };
    const outputConfig: Anthropic.OutputConfig = {};
    if (MODELS[model].effort) outputConfig.effort = cfg.effort;
    if (format && jsonMode === "grammar") outputConfig.format = { type: "json_schema", schema: format.schema };
    if (Object.keys(outputConfig).length) params.output_config = outputConfig;

    // The cap, checked before every API call (a retry is a call): hold this
    // call's ceiling against the day, or make no call at all.
    let ticket: SpendTicket | null = null;
    if (deps.budget) {
      let held: Awaited<ReturnType<Budget["reserve"]>>;
      try {
        held = await deps.budget.reserve(estimateUsd(model, params));
      } catch {
        held = { ok: false, reason: "unavailable" };
      }
      if (!held.ok) {
        attempts -= 1;
        lastError =
          held.reason === "cap"
            ? new AiError("cap", AI_CAP_MESSAGE, `daily cap of $${AI_DAILY_CAP_USD} reached`)
            : new AiError("cap", AI_LEDGER_DOWN_MESSAGE, "spend counter unreachable");
        break;
      }
      ticket = held.ticket;
    }
    const settle = async (usd: number) => {
      if (!ticket || !deps.budget) return;
      try {
        await deps.budget.settle(ticket, usd);
      } catch {
        // The day's row keeps the held amount: an over-count, never an under-count.
      }
    };
    const callModel = model;

    let msg: Message;
    try {
      msg = await deps.create(params, { timeout: Math.max(1_000, deadline - now()), maxRetries: 0 });
    } catch (err) {
      const f = classifyError(err);
      // An error answer is not billed. A timeout may have been, partly: it
      // keeps its whole estimate, so the day never under-counts.
      await settle(f.kind === "timeout" && ticket ? ticket.usd : 0);
      if (jsonMode === "grammar" && isSchemaRejection(err)) {
        jsonMode = "prompt";
        lastError = new AiError("permanent", "The model could not answer just now.", f.detail);
        continue;
      }
      lastError = new AiError(f.kind, f.kind === "timeout" ? "The model ran out of time." : "The model could not answer just now.", f.detail);
      if (f.retry === "never") break;
      if (f.retry === "fallback" && !toFallback()) {
        // Already on the fallback: a permanent failure ends it, an overload
        // gets the one plain retry that is left.
        if (f.kind === "permanent" || attempts >= MAX_ATTEMPTS) break;
      } else if (f.retry === "same" && attempts >= 2) {
        // A second transient failure on one model moves to the other.
        toFallback();
      }
      const wait = backoffMs(attempts, f.waitMs);
      if (now() + wait + MIN_ATTEMPT_MS > deadline) break;
      await sleep(wait);
      continue;
    }

    usage.input += msg.usage?.input_tokens ?? 0;
    usage.output += msg.usage?.output_tokens ?? 0;
    usage.cacheRead += msg.usage?.cache_read_input_tokens ?? 0;
    usage.cacheWrite += msg.usage?.cache_creation_input_tokens ?? 0;
    const callCost = costUsd(callModel, {
      input: msg.usage?.input_tokens ?? 0,
      output: msg.usage?.output_tokens ?? 0,
      cacheRead: msg.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: msg.usage?.cache_creation_input_tokens ?? 0,
      webSearches: msg.usage?.server_tool_use?.web_search_requests ?? 0,
    });
    usage.costUsd += callCost;
    await settle(callCost);
    lastStop = msg.stop_reason ?? null;
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    lastText = text;

    if (msg.stop_reason === "refusal") {
      lastError = new AiError("refusal", "The model declined this one.", "stop_reason refusal");
      if (toFallback()) continue;
      break;
    }

    if (!req.schema) {
      if (msg.stop_reason === "max_tokens" && !text.trim()) {
        lastError = new AiError("invalid", "The answer came back empty.", "max_tokens before any text");
        maxTokens = Math.min(MAX_TOKENS_CEILING, maxTokens * 2);
        continue;
      }
      await record(true, "text", null);
      return { data: text as Out, text, message: msg, model, attempts, fallbackUsed };
    }

    const problem = validate(req.schema, text, msg.stop_reason);
    if (problem.ok) {
      await record(true, "pass", null);
      return { data: problem.value as Out, text, message: msg, model, attempts, fallbackUsed };
    }
    lastError = new AiError("invalid", "The answer came back in a shape the app cannot use.", problem.issue);
    if (correctedOnce) break;
    correctedOnce = true;
    if (msg.stop_reason === "max_tokens") {
      maxTokens = Math.min(MAX_TOKENS_CEILING, maxTokens * 2);
    } else {
      // Append-only: the original turn stays as it was, the correction follows it.
      messages = [
        ...req.messages,
        {
          role: "user",
          content: `Your previous answer could not be used: ${problem.issue}. Answer again with only the JSON object the schema asks for. Every rule above still holds; never fill a field the text does not support.`,
        },
      ];
    }
  }

  const err = lastError ?? new AiError("timeout", "The model ran out of time.", "deadline reached before an attempt");
  await record(false, err.kind === "invalid" || err.kind === "refusal" ? "fail" : "error", `${err.kind}: ${err.detail ?? err.message}`);
  throw err;
}

type Json = { [k: string]: unknown };

/**
 * The JSON schema sent as output_config.format, from the zod schema. Our own
 * pass rather than the SDK's zodOutputFormat: that helper (0.98) folds `enum`
 * into the description text, so the grammar would no longer hold a kind or an
 * outcome to its listed values. Kept here: type, enum, const, anyOf,
 * description, properties, required, items. Dropped: what structured outputs
 * cannot take ($schema, numeric and length bounds); zod still checks those
 * after the reply. Every object is closed (additionalProperties: false).
 */
export function strictJsonSchema(schema: z.ZodType): Json {
  const walk = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(walk);
    const src = node as Json;
    const out: Json = {};
    for (const key of ["type", "enum", "const", "description", "required", "$ref"]) {
      if (src[key] !== undefined) out[key] = src[key];
    }
    if (src.anyOf) out.anyOf = (src.anyOf as unknown[]).map(walk);
    if (src.oneOf) out.anyOf = (src.oneOf as unknown[]).map(walk);
    if (src.items) out.items = walk(src.items);
    if (src.$defs) out.$defs = Object.fromEntries(Object.entries(src.$defs as Json).map(([k, v]) => [k, walk(v)]));
    if (src.properties) {
      out.properties = Object.fromEntries(Object.entries(src.properties as Json).map(([k, v]) => [k, walk(v)]));
      out.additionalProperties = false;
    } else if (src.type === "object") {
      out.additionalProperties = false;
    }
    return out;
  };
  // io "input": a field that reads "" back as null is a plain string to the model.
  return walk(toJSONSchema(schema, { target: "draft-2020-12", io: "input" })) as Json;
}

/** Parameters whose schema is a union (anyOf, or a type array like
 *  ["string","null"]), counted the way the structured-outputs limit counts. */
export function unionCount(schema: unknown): number {
  let n = 0;
  const walk = (node: unknown, isParam: boolean) => {
    if (!node || typeof node !== "object") return;
    const o = node as Json;
    if (isParam && (Array.isArray(o.anyOf) || Array.isArray(o.type))) n += 1;
    if (o.properties) for (const v of Object.values(o.properties as Json)) walk(v, true);
    if (o.items) walk(o.items, false);
    if (Array.isArray(o.anyOf)) for (const v of o.anyOf) walk(v, false);
  };
  walk(schema, false);
  return n;
}

/** Parse and check a structured reply. Exported for the offline evals. */
export function validate<S extends z.ZodType>(
  schema: S,
  text: string,
  stopReason: string | null,
): { ok: true; value: z.infer<S> } | { ok: false; issue: string } {
  if (stopReason === "max_tokens") return { ok: false, issue: "the answer was cut off before it finished" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Prompt mode can wrap the object in prose or a code fence.
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    try {
      raw = a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : undefined;
    } catch {
      raw = undefined;
    }
  }
  if (raw === undefined) {
    return { ok: false, issue: "the answer was not valid JSON" };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 4)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, issue: `fields did not match the schema (${issues})` };
}
