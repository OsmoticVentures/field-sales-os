/**
 * Tier 4: a general web search, the last resort, only run when tiers 1-3
 * found no decision maker (nutribiotic-enricher.md: "before I search tiers
 * 3-4, I check whether tier 1-2 has already been read", and tier 4 is the
 * weakest tier, spent only when the stronger ones came back empty).
 *
 * TWO CALLS, NOT ONE, so a forced extraction schema and Anthropic's own
 * web_search server tool are never asked of the model in the same turn
 * (tool_choice can force exactly one tool, and forcing the extractor first
 * would prevent the search from ever running). Call 1 lets the model search
 * and answer in its own words, grounded only in what the results said. Call
 * 2 forces the same verbatim-only extraction schema site-pass.ts uses, over
 * that answer, so a name never reaches nb_contacts without a source_text a
 * human could check.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import type { FoundPerson } from "./types";

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

export type WebSearchPassResult = {
  ran: boolean;
  skipped_reason?: string;
  people: FoundPerson[];
  query: string;
  closed_signal: string | null;
};

const EXTRACT_TOOL = {
  name: "extract_websearch_people",
  description: "Extract every named person and role stated in the search findings text, verbatim only.",
  input_schema: {
    type: "object" as const,
    properties: {
      people: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            title: { type: ["string", "null"] },
            is_decision_maker: { type: "boolean", description: "True only if the title states or clearly implies ownership or management." },
            source_text: { type: "string", description: "The exact sentence or clause the findings text stated this in." },
            source_url: { type: ["string", "null"], description: "The URL the findings cited for this fact, if one was given." },
          },
          required: ["name", "title", "is_decision_maker", "source_text", "source_url"],
        },
      },
      closed_signal: {
        type: ["string", "null"],
        description: "A verbatim snippet suggesting the business has closed permanently, or null if nothing in the findings suggests that.",
      },
    },
    required: ["people", "closed_signal"],
  },
};

type ExtractOutput = {
  people: { name: string; title: string | null; is_decision_maker: boolean; source_text: string; source_url: string | null }[];
  closed_signal: string | null;
};

export async function runWebSearchPass(accountName: string, city: string | null, state: string | null): Promise<WebSearchPassResult> {
  if (!client) return { ran: false, skipped_reason: "ANTHROPIC_API_KEY is not configured.", people: [], query: "", closed_signal: null };

  const place = [accountName, city, state].filter(Boolean).join(", ");
  const query = `who owns or manages ${place}`;

  let findings = "";
  try {
    const search = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 900,
      system:
        "Search the web to find who owns or manages the named business, and answer in plain text using only what the search results actually say. " +
        "Name the source (a URL or a publication) for every claim. If nothing found says who owns or manages it, say so plainly rather than guessing. " +
        "Also say if a result suggests the business has closed permanently.",
      messages: [{ role: "user", content: `Business: ${place}` }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    });
    findings = search.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
  } catch (err) {
    return { ran: false, skipped_reason: err instanceof Error ? err.message : "Web search failed.", people: [], query, closed_signal: null };
  }
  if (!findings.trim()) return { ran: true, skipped_reason: "Search returned nothing usable.", people: [], query, closed_signal: null };

  let out: ExtractOutput | null = null;
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 700,
      system: "Extract only what this findings text states. Never add a name, role, or fact the text does not contain.",
      messages: [{ role: "user", content: findings }],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "extract_websearch_people" },
    });
    const toolUse = msg.content.find((b) => b.type === "tool_use");
    if (toolUse && toolUse.type === "tool_use") out = toolUse.input as ExtractOutput;
  } catch {
    return { ran: true, skipped_reason: "Could not extract structured findings.", people: [], query, closed_signal: null };
  }
  if (!out) return { ran: true, skipped_reason: "Could not extract structured findings.", people: [], query, closed_signal: null };

  const people: FoundPerson[] = (out.people || [])
    .filter((p) => p.name && p.name.trim().length >= 2)
    .map((p) => ({
      name: p.name.trim(),
      title: p.title && p.title.trim() ? p.title.trim() : null,
      is_decision_maker: Boolean(p.is_decision_maker && p.title),
      source_tier: "websearch",
      found_by: `websearch: "${query}"`,
      basis: `web search, "${(p.source_text || "").slice(0, 90)}"`,
      source_text: p.source_text || null,
      source_url: p.source_url || null,
    }));

  return { ran: true, people, query, closed_signal: out.closed_signal || null };
}
