/**
 * The same AI call, answered on Juan's Max plan by his laptop while it is open,
 * from the deployed app. The request goes into nb_note_reads with its own spec
 * (supabase 0111); bridges/nutribiotic/note_reader.py claims it within a poll,
 * runs `claude -p` with that system prompt and schema, and writes the answer
 * back. Opt-in per call (AiRequest.preferMac). Any miss (lid shut, no claim in
 * time, a failed or slow answer) throws, and ai() asks the metered key instead.
 */
import "server-only";
import type Anthropic from "@anthropic-ai/sdk";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

/** The reader polls every 4s; seen within this window means awake. */
const AWAKE_MS = 12_000;
/** No claim by now means it went to sleep. */
const CLAIM_MS = 9_000;
/** A drafted email on Sonnet takes ~20 to 60s through the CLI. */
const ANSWER_MS = 120_000;
const POLL_MS = 1_500;

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
}

export async function macAwake(): Promise<boolean> {
  if (!SB_URL || !SB_KEY) return false;
  try {
    const res = await sb("nb_mac_presence?id=eq.1&select=last_seen");
    if (!res.ok) return false;
    const [row] = (await res.json()) as { last_seen: string }[];
    return Boolean(row) && Date.now() - new Date(row.last_seen).getTime() < AWAKE_MS;
  } catch {
    return false;
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as { type?: string; text?: string }[]).map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createViaMac(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  const schema = (params.output_config?.format as { schema?: unknown } | undefined)?.schema;
  if (!schema) throw new Error("mac: only a structured call goes to the laptop");
  const created = await sb("nb_note_reads?select=id", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      text: params.messages.map((m) => textOf(m.content)).join("\n\n"),
      spec: { system: textOf(params.system ?? ""), schema, model: params.model.includes("haiku") ? "haiku" : "sonnet" },
    }),
  });
  if (!created.ok) throw new Error(`mac: could not ask (HTTP ${created.status})`);
  const [{ id }] = (await created.json()) as { id: string }[];

  const start = Date.now();
  while (Date.now() - start < ANSWER_MS) {
    await sleep(POLL_MS);
    const res = await sb(`nb_note_reads?id=eq.${id}&select=status,parsed,error`).catch(() => null);
    if (!res?.ok) continue;
    const [row] = (await res.json()) as { status: string; parsed: unknown; error: string | null }[];
    if (row?.status === "done" && row.parsed) {
      return {
        content: [{ type: "text", text: JSON.stringify(row.parsed) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      } as unknown as Anthropic.Message;
    }
    if (row?.status === "failed") throw new Error(`mac: ${row.error ?? "the laptop could not answer"}`);
    if (row?.status === "pending" && Date.now() - start > CLAIM_MS) break;
  }
  // Not answered in time: marked, so a late answer is never mistaken for a live one.
  await sb(`nb_note_reads?id=eq.${id}&status=in.(pending,reading)`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "abandoned" }),
  }).catch(() => null);
  throw new Error("mac: no answer in time");
}
