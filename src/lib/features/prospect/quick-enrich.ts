/**
 * The Angle panel's "Enrich further" pass: a roughly 30-second look at an
 * account right before Juan dials it, so the hours he's about to trust and
 * the gap-selling summary he's about to read are not stale or blank.
 *
 * PORTED UNCHANGED from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/quick-enrich.ts): same tool schema,
 * same system prompt, same sourcing rules. Per this port's own feature
 * inventory (m1), the deck's "business scout" that writes an opening angle
 * for a cold, never-contacted business is deck-only, not built anywhere in
 * the source app; this is the real, adjacent capability, an angle for an
 * account already in the book, and it is kept exactly as it was, not
 * relabeled as the deck's claim.
 *
 * No fabrication: the model sees only what these three sources actually
 * returned (the business's own website, Google Places, our own order
 * history) and is told, in the tool schema itself, to return null rather
 * than a plausible-sounding guess. applyQuickEnrichment then enforces the
 * tier ladder and blank-fill rule on the write side.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  applyQuickEnrichment,
  getAccount,
  listActivities,
  listPurchases,
  type Activity,
  type PurchaseLine,
  type PurchaseOrder,
} from "./dal";
import { searchPlaces, type PlaceCandidate } from "./places";

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

export type QuickEnrichResult = {
  ok: boolean;
  error?: string;
  businessHours: Record<string, string[][]> | null;
  hoursSource: "website" | "places" | null;
  currentState: string | null;
  futureState: string | null;
  impact: string | null;
  wroteHours: boolean;
  wroteSummary: boolean;
  skippedReason?: string;
};

const ENRICH_TOOL = {
  name: "quick_enrich_account",
  description:
    "Extract accurate business hours from the website text if explicitly stated there, and write a grounded gap-selling summary from the evidence given. Every field must come only from that evidence; return null rather than invent anything.",
  input_schema: {
    type: "object" as const,
    properties: {
      hours_found_on_website: {
        type: "boolean",
        description: "True only if the website text block explicitly states operating hours.",
      },
      hours: {
        type: ["object", "null"],
        description:
          "Only when hours_found_on_website is true: one key per day (mon,tue,wed,thu,fri,sat,sun), each an array of [open,close] 24-hour HH:MM pairs, an empty array for a day stated as closed. Include every day the website states; omit a day it says nothing about. Null when hours_found_on_website is false.",
        additionalProperties: {
          type: "array",
          items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
        },
      },
      current_state: {
        type: ["string", "null"],
        description:
          "One sentence naming the actual angle a rep opens the call with: what kind of business this really is and the specific context that changes how to sell it, grounded only in the evidence given, meetings and calls weighted highest and used first whenever any exist. Never a restatement of a Places business-status flag or a bare order-count fact. Null if the evidence is too thin to say anything a rep couldn't already see on this screen.",
      },
      future_state: {
        type: ["string", "null"],
        description:
          "One sentence naming a specific opportunity implied directly by a gap in the evidence given. Never a generic pitch line, and never just that they have zero orders so there is upside. Null if no specific gap is evidenced.",
      },
      impact: {
        type: ["string", "null"],
        description:
          "One sentence on what closing that gap is worth, grounded in the numbers already given where available, otherwise tied to a concrete detail in the evidence. Null if current_state and future_state are both null, or if all that's left to say is a generic line.",
      },
    },
    required: ["hours_found_on_website", "hours", "current_state", "future_state", "impact"],
  },
};

type EnrichToolOutput = {
  hours_found_on_website: boolean;
  hours: Record<string, string[][]> | null;
  current_state: string | null;
  future_state: string | null;
  impact: string | null;
};

function exactDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Strips a fetched page down to plain text, bounded so one slow site can't
 *  blow the 30-second budget. A blocked or slow fetch degrades to "no
 *  website evidence", never a retry loop. */
async function fetchWebsiteText(rawUrl: string): Promise<string | null> {
  try {
    const href = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
    const res = await fetch(href, {
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FieldSalesOS/1.0)" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
    return text.slice(0, 6000) || null;
  } catch {
    return null;
  }
}

function buildPurchaseDigest(orders: PurchaseOrder[], lines: PurchaseLine[]): string {
  if (orders.length === 0) return "Purchase history: no orders on file.";
  const totalRevenue = orders.reduce((sum, o) => sum + o.revenue_cents, 0) / 100;
  const lastOrder = orders[0];
  const byProduct = new Map<string, { qty: number; revenue: number }>();
  for (const line of lines) {
    if (!line.product_name) continue;
    const cur = byProduct.get(line.product_name) ?? { qty: 0, revenue: 0 };
    cur.qty += line.qty ?? 0;
    cur.revenue += line.line_revenue_cents / 100;
    byProduct.set(line.product_name, cur);
  }
  const topProducts = [...byProduct.entries()].sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 8);
  const productText = topProducts.map(([name, v]) => `${name} ($${v.revenue.toFixed(0)} lifetime)`).join("; ");
  return (
    `Purchase history: ${orders.length} orders on file, $${totalRevenue.toFixed(0)} lifetime revenue, ` +
    `last order ${exactDate(lastOrder.ordered_at.slice(0, 10))}. Products bought: ${productText || "none itemized"}.`
  );
}

function buildMeetingDigest(activities: Activity[]): string {
  if (activities.length === 0) return "Meetings and calls on file: none yet.";
  const lines = activities.slice(0, 8).map((act) => `${act.kind} ${exactDate(act.at.slice(0, 10))}: ${act.detail ?? "no detail logged"}`);
  return `Meetings and calls on file, highest quality source (real, said by the account, not a scrape):\n${lines.join("\n")}`;
}

const EMPTY_RESULT: Omit<QuickEnrichResult, "ok" | "error"> = {
  businessHours: null,
  hoursSource: null,
  currentState: null,
  futureState: null,
  impact: null,
  wroteHours: false,
  wroteSummary: false,
};

export async function enrichAccountQuickly(accountId: string): Promise<QuickEnrichResult> {
  const [account, purchases, activities] = await Promise.all([
    getAccount(accountId),
    listPurchases(accountId),
    listActivities(accountId, 30),
  ]);
  if (!account) return { ok: false, error: "Account not found.", ...EMPTY_RESULT };

  const near = account.lat != null && account.lng != null ? { lat: account.lat, lng: account.lng } : undefined;
  const placeQuery = `${account.name}, ${[account.street, account.city, account.state].filter(Boolean).join(", ")}`;

  const [placesSettled, websiteSettled] = await Promise.allSettled([
    searchPlaces(placeQuery, 1, near),
    account.website ? fetchWebsiteText(account.website) : Promise.resolve(null),
  ]);

  const place: PlaceCandidate | null = placesSettled.status === "fulfilled" ? (placesSettled.value[0] ?? null) : null;
  const siteText: string | null = websiteSettled.status === "fulfilled" ? websiteSettled.value : null;

  if (!client) {
    const placesHours = place?.businessHours ?? null;
    return { ok: false, error: "ANTHROPIC_API_KEY is not configured on this deployment.", ...EMPTY_RESULT, businessHours: placesHours, hoursSource: placesHours ? "places" : null };
  }

  const evidence = [
    `Account: ${account.name} (${account.channel}, ${account.lifecycle}), ${[account.city, account.state].filter(Boolean).join(", ") || "city unknown"}.`,
    buildMeetingDigest(activities),
    buildPurchaseDigest(purchases.orders, purchases.lines),
    place
      ? `Google Places match: status=${place.businessStatus ?? "unknown"}, hours on file at Places=${place.businessHours ? JSON.stringify(place.businessHours) : "none"}.`
      : "Google Places: no confident match found.",
    siteText
      ? `Website text (${account.website}):\n${siteText}`
      : account.website
        ? `Website is on file (${account.website}) but could not be read just now (fetch failed or blocked).`
        : "No website on file.",
    account.current_state || account.future_state || account.impact
      ? `An executive summary already exists on file (context only, do not repeat it): current="${account.current_state ?? ""}", future="${account.future_state ?? ""}", impact="${account.impact ?? ""}".`
      : "No executive summary on file yet.",
  ].join("\n\n");

  let toolOut: EnrichToolOutput | null = null;
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 700,
      system:
        "You are doing a 30-second field-rep lookup on one account right before a call, using ONLY the evidence blocks in the " +
        "user message. Never invent a fact, hour, product, or opportunity that is not present in that evidence. Extract hours " +
        "only if the website text states them explicitly; Google Places' own hours are applied separately and are not yours to " +
        "restate. The meetings-and-calls block is the highest-quality evidence given, real words from the account, not a scrape, " +
        "and is Juan's own recent experience with this business: build the gap summary from it first whenever it has anything " +
        "usable, and only fall back to the website/Places/purchase-history blocks to fill in what the meetings didn't cover. " +
        "When meetings conflict with the website or Places, believe the meetings block. The gap summary (current_state/" +
        "future_state/impact) must each name something concrete a rep does not already see elsewhere on this screen. A sentence " +
        "whose only content is a business-status flag or a bare zero-orders fact is exactly the kind of generic filler to avoid. " +
        "If the evidence (beyond a meeting) gives you nothing more specific than that, return null, never that generic sentence. " +
        "If you name a date in any field, write it the way a rep would say it out loud (e.g. 'Feb 16, 2026'), never as digits-and-dashes.",
      messages: [{ role: "user", content: evidence }],
      tools: [ENRICH_TOOL],
      tool_choice: { type: "tool", name: "quick_enrich_account" },
    });
    const toolUse = msg.content.find((b) => b.type === "tool_use");
    if (toolUse && toolUse.type === "tool_use") toolOut = toolUse.input as EnrichToolOutput;
  } catch (err) {
    const placesHours = place?.businessHours ?? null;
    return { ok: false, error: err instanceof Error ? err.message : "Enrichment failed.", ...EMPTY_RESULT, businessHours: placesHours, hoursSource: placesHours ? "places" : null };
  }

  const websiteHours = toolOut?.hours_found_on_website ? toolOut.hours : null;
  const businessHours = websiteHours ?? place?.businessHours ?? null;
  const hoursSource: "website" | "places" | null = websiteHours ? "website" : place?.businessHours ? "places" : null;

  const report = await applyQuickEnrichment(accountId, {
    business_hours: businessHours,
    hours_source_tier: hoursSource,
    hours_found_by: hoursSource === "website" ? `prospect_quick_enrich: ${account.website}` : hoursSource === "places" ? "prospect_quick_enrich: google_places" : null,
    current_state: toolOut?.current_state ?? null,
    future_state: toolOut?.future_state ?? null,
    impact: toolOut?.impact ?? null,
    gap_summary_found_by: "prospect_quick_enrich: website + google_places + purchase history",
  });

  return {
    ok: true,
    businessHours,
    hoursSource,
    currentState: report.gap_summary ? (toolOut?.current_state ?? null) : account.current_state,
    futureState: report.gap_summary ? (toolOut?.future_state ?? null) : account.future_state,
    impact: report.gap_summary ? (toolOut?.impact ?? null) : account.impact,
    wroteHours: report.business_hours?.status === "filled" || report.business_hours?.status === "updated",
    wroteSummary: report.gap_summary?.status === "filled",
    skippedReason:
      report.business_hours?.status === "skipped_stronger_tier"
        ? "Hours already on file came from a stronger source (a logged call or the website), so the Places reading was not used."
        : undefined,
  };
}
