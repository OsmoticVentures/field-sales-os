/**
 * Tier 4: a general web search, the last resort, only run when tiers 1-3
 * found no decision maker (nutribiotic-enricher.md: "before I search tiers
 * 3-4, I check whether tier 1-2 has already been read", and tier 4 is the
 * weakest tier, spent only when the stronger ones came back empty).
 *
 * TWO CALLS, NOT ONE, so a strict extraction schema and Anthropic's own
 * web_search server tool are never asked of the model in the same turn.
 * Call 1 lets the model search and answer in its own words, grounded only
 * in what the results said. Call 2 holds that answer to the same
 * verbatim-only extraction schema site-pass.ts uses, so a name never reaches
 * nb_contacts without a source_text a human could check.
 */
import "server-only";
import { z } from "zod";
import { ai, aiConfigured, AiError, isAiCap } from "../../core/ai/client";
import type { FoundPerson, Lead } from "./types";
import { verifyCited, type Citation } from "./people-guard";

export type WebSearchPassResult = {
  ran: boolean;
  skipped_reason?: string;
  people: FoundPerson[];
  leads: Lead[];
  query: string;
  closed_signal: string | null;
};

const ExtractSchema = z.object({
  people: z.array(
    z.object({
      name: z.string(),
      title: z.string().nullable(),
      is_decision_maker: z.boolean().describe("True only if the title states or clearly implies ownership or management."),
      source_text: z.string().describe("The exact sentence or clause the findings text stated this in."),
      source_url: z.string().nullable().describe("The URL the findings cited for this fact, if one was given."),
    }),
  ),
  closed_signal: z
    .string()
    .nullable()
    .describe("A verbatim snippet suggesting the business has closed permanently, or null if nothing in the findings suggests that."),
});

export async function runWebSearchPass(
  accountName: string,
  city: string | null,
  state: string | null,
  deadline = Date.now() + 45_000,
): Promise<WebSearchPassResult> {
  if (!aiConfigured()) return { ran: false, skipped_reason: "ANTHROPIC_API_KEY is not configured.", people: [], leads: [], query: "", closed_signal: null };

  const place = [accountName, city, state].filter(Boolean).join(", ");
  const query = `who owns or manages ${place}`;

  let findings = "";
  const cited: Citation[] = [];
  try {
    const { message: search } = await ai({
      task: "enrich_websearch",
      system:
        "Search the web to find who owns or manages the named business, and answer in plain text using only what the search results actually say. " +
        "Name the source (a URL or a publication) for every claim. If nothing found says who owns or manages it, say so plainly rather than guessing. " +
        "Also say if a result suggests the business has closed permanently.",
      messages: [{ role: "user", content: `Business: ${place}` }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
      deadline: deadline - 12_000,
    });
    findings = search.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    // The passages the search itself cited are the evidence. The model's prose
    // is not: a person is admitted only if one of these prints them.
    for (const b of search.content) {
      if (b.type !== "text" || !Array.isArray(b.citations)) continue;
      for (const c of b.citations) {
        const cc = c as { url?: string; cited_text?: string };
        if (cc.url && cc.cited_text) cited.push({ url: cc.url, text: cc.cited_text });
      }
    }
  } catch (err) {
    if (isAiCap(err)) return { ran: false, skipped_reason: `No web search. ${err.message}`, people: [], leads: [], query, closed_signal: null };
    const timedOut = err instanceof AiError && err.kind === "timeout";
    return { ran: false, skipped_reason: timedOut ? "The web search ran out of time." : "The web search could not run just now.", people: [], leads: [], query, closed_signal: null };
  }
  if (!findings.trim()) return { ran: true, skipped_reason: "Search returned nothing usable.", people: [], leads: [], query, closed_signal: null };

  let out: z.infer<typeof ExtractSchema>;
  try {
    const res = await ai({
      task: "enrich_websearch_extract",
      system:
        "Extract only what this findings text states. Never add a name, role, or fact the text does not contain." +
        // The old extraction tool's own instruction: who to extract, verbatim.
        " Extract every named person and role stated in the search findings text, verbatim only.",
      messages: [{ role: "user", content: findings }],
      schema: ExtractSchema,
      deadline,
    });
    out = res.data;
  } catch (err) {
    // Nothing from the search is kept unread: no half a finding.
    if (isAiCap(err)) return { ran: false, skipped_reason: `The search ran but was not read. ${err.message}`, people: [], leads: [], query, closed_signal: null };
    return { ran: true, skipped_reason: "Could not extract structured findings.", people: [], leads: [], query, closed_signal: null };
  }

  const people: FoundPerson[] = [];
  const leads: Lead[] = [];
  for (const p of out.people) {
    if (p.name.trim().length < 2) continue;
    const verdict = verifyCited({ name: p.name, title: p.title }, cited);
    if (verdict.ok) {
      people.push({
        name: p.name.trim(),
        title: verdict.title,
        is_decision_maker: verdict.is_decision_maker,
        source_tier: "websearch",
        found_by: `websearch: "${query}"`,
        basis: `web search, a cited passage prints the name and the title`,
        source_text: verdict.source_text,
        source_url: verdict.source_url,
      });
    } else {
      leads.push({ name: p.name.trim().slice(0, 80), claim: (p.title || "named").slice(0, 60), basis: `search summary only. ${verdict.reason}`.slice(0, 200), confirmed: false });
    }
  }

  return { ran: true, people, leads: leads.slice(0, 5), query, closed_signal: out.closed_signal || null };
}
