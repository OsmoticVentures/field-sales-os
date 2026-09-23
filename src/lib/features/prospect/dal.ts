/**
 * Data access for Prospecting Agents (/prospect). The only place this
 * feature touches Supabase, same raw-fetch PostgREST pattern as
 * lib/core/devices.ts and the source app's lib/dal.ts. Reads the same
 * tables the NutriBiotic OS's SDR screen reads: nb_accounts, nb_contacts
 * (written by the Mac-side headhunter, unchanged, this only reads what it
 * wrote), nb_activities, nb_orders/nb_order_lines, nb_sdr_schedule, plus the
 * territory-area and priority views.
 *
 * SCOPE NOTE for m9 (see this agent's handback): this is a feature-local
 * slice, not the full 5,243-line source lib/dal.ts. It ports every read/
 * write the Prospect screen actually needs (schedule, account panel,
 * search, quick enrich) and leaves out what depends on shared pipelines not
 * yet ported to this repo (the touchpoint capture/logging box, the route
 * draft, and the hide-chains/practices/prospects toggles all live on
 * nb_ui_prefs and touchpoint.ts, shared with Route Planner and Visit
 * Logger). Marking done/skipped here works standalone, the same "done by
 * hand, no activity id" case the source app already supports.
 */
import "server-only";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

export const isConfigured = (): boolean => Boolean(SB_URL && SB_KEY);

/** Juan's HubSpot owner id, the one territory this whole app scopes to. */
const JUAN_OWNER_ID = "36242368";

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw err instanceof Error && err.name === "AbortError"
      ? new Error(`Request to ${url} timed out after ${timeoutMs}ms.`)
      : err;
  } finally {
    clearTimeout(timer);
  }
}

async function sbGet<T>(table: string, params: URLSearchParams): Promise<T[]> {
  if (!isConfigured()) return [];
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}?${params}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase ${table} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T[];
}

async function sbWrite<T>(table: string, method: "POST" | "PATCH", body: unknown, params?: URLSearchParams): Promise<T[]> {
  if (!isConfigured()) throw new Error(`Cannot write to "${table}": no data source configured.`);
  const qs = params ? `?${params}` : "";
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}${qs}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${table} ${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T[]) : [];
}

/** Our id shape throughout this schema: '<prefix>_<6 hex>'. */
function randId(prefix: string): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function todayStartLA(): string {
  const iso = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  return `${iso}T00:00:00`;
}

// ---------------------------------------------------------------------------
// Account, contacts, activities, purchases (the account panel)
// ---------------------------------------------------------------------------

export type Account = {
  id: string;
  name: string;
  channel: string;
  area: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
  lifecycle: string;
  last_order_at: string | null;
  lifetime_revenue: number | null;
  trailing_12m_revenue: number | null;
  expected_reorder_at: string | null;
  quirks: string | null;
  current_state: string | null;
  future_state: string | null;
  impact: string | null;
  business_hours: Record<string, string[][]> | null;
  enrichment_status: Record<string, { source_tier?: string; [k: string]: unknown }> | null;
  hubspot_company_id: string | null;
  potential_juan: string | null;
  readiness: "urgent" | "hot" | "normal" | "cold" | null;
  lead_status: string | null;
};

export async function getAccount(id: string): Promise<Account | null> {
  const rows = await sbGet<Account>("nb_accounts", new URLSearchParams({ select: "*", id: `eq.${id}`, limit: "1" }));
  return rows[0] ?? null;
}

export async function setAccountPhone(accountId: string, phone: string): Promise<void> {
  await sbWrite("nb_accounts", "PATCH", { phone }, new URLSearchParams({ id: `eq.${accountId}` }));
}

export async function setAccountPotentialJuan(accountId: string, grade: string | null): Promise<void> {
  await sbWrite("nb_accounts", "PATCH", { potential_juan: grade }, new URLSearchParams({ id: `eq.${accountId}` }));
}

export type Contact = {
  id: string;
  account_id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  is_decision_maker: boolean;
  email: string | null;
  phone: string | null;
};

/** Named people at an account, as the Mac-side headhunter (bridges/
 *  nutribiotic/headhunter.py) wrote them from the business's own site. This
 *  app never runs the headhunter itself, only reads what it filed. */
export async function listContacts(accountId: string): Promise<Contact[]> {
  return sbGet<Contact>(
    "nb_contacts",
    new URLSearchParams({ select: "*", account_id: `eq.${accountId}`, order: "is_decision_maker.desc,last_name.asc" }),
  );
}

export type Activity = { id: number; account_id: string; at: string; kind: string; detail: string | null; origin: string };

/** Calls and meetings only, most recent first: the enrichment pipeline's own
 *  system notes (a geocode pass, e.g.) are filtered out so this never reads
 *  as if something happened with the client that didn't. */
export async function listActivities(accountId: string, limit = 30): Promise<Activity[]> {
  const rows = await sbGet<Activity>(
    "nb_activities",
    new URLSearchParams({ select: "id,account_id,at,kind,detail,origin", account_id: `eq.${accountId}`, order: "at.desc", limit: String(limit) }),
  );
  return rows.filter((a) => a.origin !== "enriched" && (a.kind === "call" || a.kind === "meeting"));
}

export type PurchaseOrder = { id: string; ordered_at: string; revenue_cents: number };
export type PurchaseLine = { order_id: string; product_name: string | null; qty: number | null; line_revenue_cents: number };

export async function listPurchases(accountId: string): Promise<{ orders: PurchaseOrder[]; lines: PurchaseLine[] }> {
  const [orders, lines] = await Promise.all([
    sbGet<PurchaseOrder>(
      "nb_orders",
      new URLSearchParams({ select: "id,ordered_at,revenue_cents", account_id: `eq.${accountId}`, order: "ordered_at.desc", limit: "500" }),
    ),
    sbGet<PurchaseLine>(
      "nb_order_lines",
      new URLSearchParams({ select: "order_id,product_name,qty,line_revenue_cents", account_id: `eq.${accountId}` }),
    ),
  ]);
  if (orders.length === 0) return { orders: [], lines: [] };
  const orderIds = new Set(orders.map((o) => o.id));
  return { orders, lines: lines.filter((l) => orderIds.has(l.order_id)) };
}

export type PurchaseSummaryItem = { name: string; qty: number; revenueCents: number; last3Qty: number };
export type PurchaseSummary = { orderCount: number; topItems: PurchaseSummaryItem[]; smallItemNames: string[] };

export function summarizePurchases(orders: PurchaseOrder[], lines: PurchaseLine[]): PurchaseSummary | null {
  if (orders.length === 0) return null;
  const last3OrderIds = new Set(orders.slice(0, 3).map((o) => o.id));
  const totals = new Map<string, PurchaseSummaryItem>();
  for (const l of lines) {
    const name = l.product_name ?? "Item";
    const cur = totals.get(name) ?? { name, qty: 0, revenueCents: 0, last3Qty: 0 };
    cur.qty += l.qty ?? 0;
    cur.revenueCents += l.line_revenue_cents;
    if (last3OrderIds.has(l.order_id)) cur.last3Qty += l.qty ?? 0;
    totals.set(name, cur);
  }
  const items = [...totals.values()].filter((t) => t.qty !== 0).sort((a, b) => b.qty - a.qty);
  return { orderCount: orders.length, topItems: items.slice(0, 5), smallItemNames: items.slice(5).map((t) => t.name) };
}

// ---------------------------------------------------------------------------
// SDR schedule: the call list itself
// ---------------------------------------------------------------------------

export type SdrPriority = "low" | "mid" | "high";

export type SdrScheduleItem = {
  id: string;
  account_id: string | null;
  prospect_name: string | null;
  prospect_phone: string | null;
  kind: "call" | "visit";
  scheduled_date: string;
  status: "pending" | "done" | "skipped";
  notes: string | null;
  completed_activity_id: number | null;
  created_at: string;
  rescheduled_at: string | null;
  priority: SdrPriority | null;
};

/** From today through `days` out, oldest first. */
export async function listSdrSchedule(days = 6): Promise<SdrScheduleItem[]> {
  const from = todayStartLA().slice(0, 10);
  const to = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const rows = await sbGet<SdrScheduleItem>(
    "nb_sdr_schedule",
    new URLSearchParams({ select: "*", scheduled_date: `gte.${from}`, order: "scheduled_date.asc,created_at.asc", limit: "500" }),
  );
  return rows.filter((r) => r.scheduled_date <= to);
}

export type NewSdrScheduleItem = {
  account_id?: string | null;
  prospect_name?: string | null;
  prospect_phone?: string | null;
  kind: "call" | "visit";
  scheduled_date: string;
  notes?: string | null;
  priority?: SdrPriority | null;
};

/** Scope is asserted here: an account_id must be in Juan's own book. A
 *  prospect row (account_id null) belongs to nobody's book yet. */
export async function insertSdrScheduleItem(input: NewSdrScheduleItem): Promise<SdrScheduleItem> {
  if (input.account_id) {
    const owned = await sbGet<{ id: string }>(
      "nb_accounts",
      new URLSearchParams({ select: "id", id: `eq.${input.account_id}`, hubspot_owner_id: `eq.${JUAN_OWNER_ID}`, limit: "1" }),
    );
    if (!owned[0]) throw new Error("That account is not in Juan's book, nothing was scheduled.");
  }
  const [row] = await sbWrite<SdrScheduleItem>("nb_sdr_schedule", "POST", {
    id: randId("sdr"),
    account_id: input.account_id ?? null,
    prospect_name: input.prospect_name ?? null,
    prospect_phone: input.prospect_phone ?? null,
    kind: input.kind,
    scheduled_date: input.scheduled_date,
    notes: input.notes ?? null,
    priority: input.priority ?? null,
    status: "pending",
    origin: "manual",
  });
  return row;
}

export async function rescheduleSdrScheduleItem(id: string, scheduledDate: string): Promise<SdrScheduleItem> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) throw new Error("Not a date.");
  const [row] = await sbWrite<SdrScheduleItem>(
    "nb_sdr_schedule",
    "PATCH",
    { scheduled_date: scheduledDate, rescheduled_at: new Date().toISOString() },
    new URLSearchParams({ id: `eq.${id}` }),
  );
  return row;
}

export async function setSdrScheduleStatus(
  id: string,
  status: "pending" | "done" | "skipped",
  completedActivityId?: number | null,
): Promise<SdrScheduleItem> {
  const patch: Record<string, unknown> = { status };
  if (completedActivityId !== undefined) patch.completed_activity_id = completedActivityId;
  const [row] = await sbWrite<SdrScheduleItem>("nb_sdr_schedule", "PATCH", patch, new URLSearchParams({ id: `eq.${id}` }));
  return row;
}

export type AccountCallCard = {
  name: string;
  phone: string | null;
  area: string | null;
  businessHours: Record<string, string[][]> | null;
};

export async function getAccountCallCards(ids: string[]): Promise<Record<string, AccountCallCard>> {
  if (ids.length === 0) return {};
  const rows = await sbGet<{ id: string; name: string; phone: string | null; area: string | null; business_hours: Record<string, string[][]> | null }>(
    "nb_accounts",
    new URLSearchParams({ select: "id,name,phone,area,business_hours", id: `in.(${ids.join(",")})` }),
  );
  return Object.fromEntries(
    rows.map((a) => [a.id, { name: a.name, phone: a.phone, area: a.area, businessHours: a.business_hours }]),
  );
}

/** A light, single-account-name-search picker, filtered server-side. */
export async function searchOwnedAccounts(
  nameQuery: string,
  limit = 8,
): Promise<{ id: string; name: string; city: string | null; phone: string | null; area: string | null }[]> {
  const q = nameQuery.trim().replace(/[%,]/g, "");
  if (!q) return [];
  return sbGet(
    "nb_accounts",
    new URLSearchParams({
      select: "id,name,city,phone,area",
      hubspot_owner_id: `eq.${JUAN_OWNER_ID}`,
      closed_at: "is.null",
      name: `ilike.*${q}*`,
      order: "name.asc",
      limit: String(limit),
    }),
  );
}

/** A person-name search across Juan's owned, open accounts. */
export async function searchOwnedContacts(
  nameQuery: string,
  limit = 8,
): Promise<{ id: string; name: string; title: string | null; account_id: string; account_name: string; city: string | null; phone: string | null }[]> {
  const q = nameQuery.trim().replace(/[%,]/g, "");
  if (!q) return [];
  const hits = await sbGet<{ id: string; first_name: string | null; last_name: string | null; title: string | null; phone: string | null; account_id: string }>(
    "nb_contacts",
    new URLSearchParams({ select: "id,first_name,last_name,title,phone,account_id", or: `(first_name.ilike.*${q}*,last_name.ilike.*${q}*)`, limit: String(limit * 3) }),
  );
  if (hits.length === 0) return [];
  const accountIds = [...new Set(hits.map((h) => h.account_id))];
  const accounts = await sbGet<{ id: string; name: string; city: string | null; phone: string | null }>(
    "nb_accounts",
    new URLSearchParams({ select: "id,name,city,phone", id: `in.(${accountIds.join(",")})`, hubspot_owner_id: `eq.${JUAN_OWNER_ID}`, closed_at: "is.null" }),
  );
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return hits
    .map((h) => {
      const a = byId.get(h.account_id);
      if (!a) return null;
      const name = [h.first_name, h.last_name].filter(Boolean).join(" ") || "Unnamed contact";
      return { id: h.id, name, title: h.title, account_id: a.id, account_name: a.name, city: a.city, phone: h.phone ?? a.phone };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Territory areas and the priority book
// ---------------------------------------------------------------------------

export type TerritoryArea = { id: string; label: string; color: string };

export async function listAreas(): Promise<TerritoryArea[]> {
  return sbGet<TerritoryArea>("nb_territory_areas", new URLSearchParams({ select: "id,label,color", order: "display_order.asc" }));
}

import {
  areaProspectCounts,
  byOriginThenPriority,
  computePriority,
  type PriorityInput,
  type PriorityResult,
  type Readiness,
} from "./priority";

export type PriorityBook = {
  byId: Map<string, PriorityResult>;
  ranked: { account: PriorityInput; result: PriorityResult }[];
  areaProspects: Map<string, number>;
};

export async function getPriorityBook(): Promise<PriorityBook> {
  const empty: PriorityBook = { byId: new Map(), ranked: [], areaProspects: new Map() };
  if (!isConfigured()) return empty;

  const [accounts, grades, drafts, touches] = await Promise.all([
    sbGet<{
      id: string;
      name: string;
      lifecycle: string | null;
      phone: string | null;
      trailing_12m_revenue: number | null;
      lifetime_revenue: number | null;
      first_order_at: string | null;
      last_order_at: string | null;
      expected_reorder_days: number | null;
      places_status: string | null;
      closed_at: string | null;
      do_not_visit: boolean | null;
      area: string | null;
      readiness: Readiness | null;
      channel: string | null;
      origin: string | null;
    }>(
      "nb_accounts",
      new URLSearchParams({
        select:
          "id,name,lifecycle,phone,area,trailing_12m_revenue,lifetime_revenue,first_order_at,last_order_at,expected_reorder_days,places_status,closed_at,do_not_visit,readiness,channel,origin",
        hubspot_owner_id: `eq.${JUAN_OWNER_ID}`,
        lifecycle: "neq.waypoint",
        closed_at: "is.null",
        chain_excluded: "eq.false",
        limit: "2000",
      }),
    ),
    sbGet<{ account_id: string; potential_grade: string | null }>(
      "nb_v_account_potential",
      new URLSearchParams({ select: "account_id,potential_grade", limit: "2000" }),
    ),
    sbGet<{ account_id: string | null; urgency: number | null; urgency_reason: string | null }>(
      "nb_outbound_drafts",
      new URLSearchParams({ select: "account_id,urgency,urgency_reason", status: "eq.pending", limit: "500" }),
    ),
    sbGet<{ account_id: string; at: string }>(
      "nb_v_activities_effective",
      new URLSearchParams({ select: "account_id,at", corrected: "is.false", retracted: "is.false", order: "at.desc", limit: "2000" }),
    ),
  ]);

  const gradeById = new Map(grades.map((g) => [g.account_id, g.potential_grade]));
  const lastTouch = new Map<string, string>();
  for (const t of touches) if (!lastTouch.has(t.account_id)) lastTouch.set(t.account_id, t.at);
  const urgencyById = new Map<string, { urgency: number | null; urgency_reason: string | null }>();
  for (const d of drafts) {
    if (!d.account_id) continue;
    const prev = urgencyById.get(d.account_id);
    if (!prev || (d.urgency ?? -1) > (prev.urgency ?? -1)) urgencyById.set(d.account_id, d);
  }

  const inputs: PriorityInput[] = accounts.map((a) => ({
    ...a,
    tier: gradeById.get(a.id) ?? null,
    urgency: urgencyById.get(a.id)?.urgency ?? null,
    urgency_reason: urgencyById.get(a.id)?.urgency_reason ?? null,
    last_touch_at: lastTouch.get(a.id) ?? null,
  }));

  const byId = computePriority(inputs);
  const ranked = inputs
    .map((account) => ({ account, result: byId.get(account.id)! }))
    .filter((r) => r.result.score !== null)
    .sort(byOriginThenPriority);

  return { byId, ranked, areaProspects: areaProspectCounts(inputs, byId) };
}

// ---------------------------------------------------------------------------
// Quick enrichment write (see quick-enrich.ts for the model call itself)
// ---------------------------------------------------------------------------

const HOURS_TIER_RANK: Record<string, number> = { manual_note: 0, website: 1, places: 2 };

export type QuickEnrichPatch = {
  business_hours: Record<string, string[][]> | null;
  hours_source_tier: "website" | "places" | null;
  hours_found_by: string | null;
  current_state: string | null;
  future_state: string | null;
  impact: string | null;
  gap_summary_found_by: string | null;
};

export type QuickEnrichReport = {
  business_hours: { status: "filled" | "updated" | "skipped_stronger_tier" } | null;
  gap_summary: { status: "filled" } | null;
};

/** Same discipline as the source app: a stronger hours tier already on file
 *  is never demoted by a weaker one, and an existing gap summary is never
 *  overwritten, only filled where all three fields are still blank. */
export async function applyQuickEnrichment(accountId: string, patch: QuickEnrichPatch): Promise<QuickEnrichReport> {
  const report: QuickEnrichReport = { business_hours: null, gap_summary: null };
  const row = await getAccount(accountId);
  if (!row) return report;

  const dbPatch: Record<string, unknown> = {};
  const status = { ...(row.enrichment_status || {}) };

  if (patch.business_hours && patch.hours_source_tier) {
    const existingTier = row.enrichment_status?.business_hours?.source_tier as string | undefined;
    const existingRank = existingTier ? (HOURS_TIER_RANK[existingTier] ?? 99) : 99;
    const newRank = HOURS_TIER_RANK[patch.hours_source_tier];
    if (newRank < existingRank) {
      dbPatch.business_hours = patch.business_hours;
      status.business_hours = { source_tier: patch.hours_source_tier, found_by: patch.hours_found_by ?? "prospect_quick_enrich", at: new Date().toISOString() };
      report.business_hours = { status: row.business_hours ? "updated" : "filled" };
    } else {
      report.business_hours = { status: "skipped_stronger_tier" };
    }
  }

  if (!row.current_state && !row.future_state && !row.impact && (patch.current_state || patch.future_state || patch.impact)) {
    dbPatch.current_state = patch.current_state;
    dbPatch.future_state = patch.future_state;
    dbPatch.impact = patch.impact;
    status.gap_summary = { source_tier: "prospect_quick_enrich", found_by: patch.gap_summary_found_by ?? "prospect_quick_enrich", at: new Date().toISOString() };
    report.gap_summary = { status: "filled" };
  }

  if (Object.keys(dbPatch).length > 0) {
    dbPatch.enrichment_status = status;
    await sbWrite("nb_accounts", "PATCH", dbPatch, new URLSearchParams({ id: `eq.${accountId}` }));
  }
  return report;
}
