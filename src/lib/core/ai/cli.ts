/**
 * The same AI call, answered by `claude -p` on Juan's Max plan instead of the
 * metered API (Juan, 2026-11-04: "regular credits and only once i open laptop").
 * Only a Mac script can use it, by setting NB_AI_CLI=1; the deployed app never
 * does. Same flags as bridges/lib/claude_cli.py: no tools, no settings, and the
 * API key stripped from the child, so the call cannot bill the API.
 */
import "server-only";
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";

const TIMEOUT_MS = 120_000;

function claudeBin(): string {
  const home = process.env.HOME ?? "";
  for (const p of [process.env.CLAUDE_BIN, `${home}/.local/bin/claude`, `${home}/.npm-global/bin/claude`, "/opt/homebrew/bin/claude"]) {
    if (!p) continue;
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // the next place
    }
  }
  return "claude";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return (content as { type?: string; text?: string }[]).map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

export async function createViaCli(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  const prompt = params.messages.map((m) => textOf(m.content)).join("\n\n");
  const schema = (params.output_config?.format as { schema?: unknown } | undefined)?.schema;
  const args = [
    "-p", prompt,
    "--model", params.model.includes("haiku") ? "haiku" : "sonnet",
    "--output-format", "json",
    ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
    "--tools", "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources", "",
    "--no-session-persistence",
    "--system-prompt", textOf(params.system ?? ""),
  ];
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(claudeBin(), args, { env, cwd: process.env.HOME, timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, out, errOut) => {
      if (err) reject(new Error(`claude: ${String(errOut || err.message).slice(-200)}`));
      else resolve(out);
    });
  });
  const outer = JSON.parse(stdout) as { is_error?: boolean; result?: string; structured_output?: unknown };
  if (outer.is_error) throw new Error(`claude: ${String(outer.result).slice(0, 200)}`);
  const text = outer.structured_output !== undefined ? JSON.stringify(outer.structured_output) : (outer.result ?? "");
  return {
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}
