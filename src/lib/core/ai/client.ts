/**
 * The server side of ./core.ts: the one Anthropic client, and the run record
 * written to nb_ai_runs. Every AI step in the app calls `ai()` from here, so
 * the model ids, timeouts, retries and validation live in exactly one place.
 *
 *   const { data } = await ai({ task: "touchpoint_extract", system, messages, schema });
 *
 * Throws AiError (re-exported) when the budget is spent; a caller turns that
 * into its own plain "could not read that" line, as it did before. When the
 * daily spend cap stops a call, the AiError's kind is "cap" (isAiCap) and its
 * message is the line to show as it is.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { AiError, runAi, type AiRequest, type AiResult } from "./core";
import { writeRunRecord } from "./run-log";
import { spendLedger } from "./spend-ledger";
import { currentUser } from "../user";

export { AiError, hashInput, isAiCap, AI_CAP_MESSAGE, AI_CAP_STATUS, AI_DAILY_CAP_USD } from "./core";

let client: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (client === undefined) {
    // maxRetries 0: the retry budget is runAi's, so the SDK's own retries
    // never multiply it.
    client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 }) : null;
  }
  return client;
}

/** True when a key is configured on this deployment. */
export function aiConfigured(): boolean {
  return getClient() !== null;
}

export async function ai<S extends z.ZodType | undefined = undefined>(
  req: AiRequest<S>,
): Promise<AiResult<S extends z.ZodType ? z.infer<S> : string>> {
  const c = getClient();
  if (!c) throw new AiError("unconfigured", "No model is configured on this deployment.");
  const actor = req.actor !== undefined ? req.actor : await currentUser().then((u) => u.id).catch(() => null);
  return runAi(
    {
      create: (params, opts) => c.messages.create(params, opts),
      log: writeRunRecord,
      budget: spendLedger,
    },
    { ...req, actor },
  );
}
