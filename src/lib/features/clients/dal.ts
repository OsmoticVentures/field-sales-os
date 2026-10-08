/**
 * Data access for Clients (/clients) and the client view (/account/[id]).
 * Ported from the source app's lib/dal.ts: listAccounts, listAreas,
 * getAccountHoursMap, listDeals, listStaleDeals, listTerritoryAccountIds
 * getAccount, listActivities, listContacts. Purchases reuse
 * lib/features/prospect/dal.ts's listPurchases.
 */
import "server-only";
import { myOwnerId } from "../../core/user";
import type { Columns, NbVAccountTierRow } from "../../db/types";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

export const isConfigured = (): boolean => Boolean(SB_URL && SB_KEY);

/** The signed-in rep's working book: owned, not chain/practice-excluded, open, not a waypoint. */
const book = async () => ({
  hubspot_owner_id: `eq.${await myOwnerId()}`,
  chain_excluded: "eq.false",
  practice_excluded: "eq.false",
  closed_at: "is.null",
  lifecycle: "neq.waypoint",
});

async function sbGet<T>(table: string, params: Record<string, string>): Promise<T[]> {
  if (!isConfigured()) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${table}?${new URLSearchParams(params)}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Supabase ${table} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T[];
  } finally {
    clearTimeout(timer);
  }
}

export type TierRow = Columns<TierFields, NbVAccountTierRow>;
type TierFields = {
  account_id: string;
  name: string;
  lifecycle: string;
  fit: number | null;
  fit_confidence: number | null;
  fit_inputs_known: number | null;
  fit_inputs_total: number | null;
  engagement: number | null;
  tier: "A" | "B" | "C" | "D";
  area: string | null;
};

/** Only the columns the Clients list draws; the order still runs on the view's
 *  fit columns inside Postgres, they just never cross the wire. */
export type ClientListRow = Pick<TierRow, "account_id" | "name" | "lifecycle" | "tier">;

export async function listClientAccounts(opts: { area?: string | null; sort?: "tier" | "engagement" } = {}): Promise<ClientListRow[]> {
  const params: Record<string, string> = {
    select: "account_id,name,lifecycle,tier",
    ...(await book()),
    order: opts.sort === "engagement" ? "engagement.desc.nullslast,tier.asc" : "tier.asc,fit_confidence.desc,fit.desc",
    limit: "500",
  };
  if (opts.area) params.area = `eq.${opts.area}`;
  return sbGet<ClientListRow>("nb_v_account_tier", params);
}

export const METRIC_FIELDS = ["shelf_units", "supp_body_pct", "employee_count", "stores_per_decision_maker"] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];
export type Metrics = Record<MetricField, number | null> & { readiness: string | null };

export type BusinessHours = Record<string, string[][]>;

/**
 * Everything Clients needs per account in the rep's book besides the list
 * itself, in one read: the four hand-entered tier fields, readiness and the
 * opening hours, keyed by id, plus the id set the pipeline is filtered to.
 * Filtered by the book rather than by a list of ids, so it runs alongside the
 * list instead of after it, and the URL stays short.
 */
export type BookFacts = {
  ids: Set<string>;
  metrics: Record<string, Metrics>;
  hours: Record<string, BusinessHours | null>;
};

export async function getBookFacts(): Promise<BookFacts> {
  const rows = await sbGet<Metrics & { id: string; business_hours: BusinessHours | null }>("nb_accounts", {
    select: `id,business_hours,readiness,${METRIC_FIELDS.join(",")}`,
    ...(await book()),
    limit: "2000",
  });
  const metrics: Record<string, Metrics> = {};
  const hours: Record<string, BusinessHours | null> = {};
  for (const { business_hours, ...m } of rows) {
    metrics[m.id] = m;
    hours[m.id] = business_hours;
  }
  return { ids: new Set(rows.map((r) => r.id)), metrics, hours };
}

/** Write one metric on an account inside the signed-in rep's own book. Blank clears it. */
export async function setMetric(accountId: string, field: MetricField, value: number | null): Promise<void> {
  if (!isConfigured()) throw new Error("No data source configured.");
  const params = new URLSearchParams({ id: `eq.${accountId}`, hubspot_owner_id: `eq.${await myOwnerId()}` });
  const res = await fetch(`${SB_URL}/rest/v1/nb_accounts?${params}`, {
    method: "PATCH",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify({ [field]: value }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase nb_accounts PATCH -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  if ((await res.json()).length === 0) throw new Error("That client is not in your book.");
}

export type ClientArea = {
  id: string;
  label: string;
  color: string;
  account_count: number | null;
};

export async function listClientAreas(): Promise<ClientArea[]> {
  return sbGet<ClientArea>("nb_territory_areas", { select: "id,label,color,account_count", order: "display_order.asc" });
}

export type Deal = {
  id: string;
  account_id: string;
  stage: string;
  next_step: string | null;
  next_step_date: string | null;
};

export type StaleDeal = {
  deal_id: string;
  account_id: string;
  account_name: string;
  stage: string;
  next_step_days_overdue: number | null;
  days_since_activity: number | null;
};

/** nb_deals and nb_v_pipeline_stale carry no owner, so both are filtered to
 *  the rep's book (getBookFacts().ids) here. */
export async function listPipeline(bookIds: Promise<Set<string>>): Promise<{ deals: Deal[]; stale: StaleDeal[] }> {
  const [deals, stale, ids] = await Promise.all([
    sbGet<Deal>("nb_deals", { select: "id,account_id,stage,next_step,next_step_date", order: "next_step_date.asc.nullslast", limit: "300" }),
    sbGet<StaleDeal>("nb_v_pipeline_stale", {
      select: "deal_id,account_id,account_name,stage,next_step_days_overdue,days_since_activity",
      order: "next_step_days_overdue.desc.nullslast",
      limit: "150",
    }),
    bookIds,
  ]);
  return {
    deals: deals.filter((d) => ids.has(d.account_id)),
    stale: stale.filter((s) => ids.has(s.account_id)).slice(0, 20),
  };
}

export type ClientAccount = {
  id: string;
  readiness?: string | null;
  hubspot_owner_id?: string | null;
  name: string;
  channel: string | null;
  street: string | null;
  city: string | null;
  postal: string | null;
  phone: string | null;
  website: string | null;
  email: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  linkedin_url: string | null;
  lifecycle: string | null;
  last_order_at: string | null;
  lifetime_revenue: number | null;
  trailing_12m_revenue: number | null;
  expected_reorder_at: string | null;
  quirks: string | null;
  current_state: string | null;
  future_state: string | null;
  impact: string | null;
  business_hours: BusinessHours | null;
  hubspot_company_id: string | null;
  potential_hq: string | null;
  potential_juan: string | null;
};

const CLIENT_ACCOUNT_SELECT =
  "id,readiness,hubspot_owner_id,name,channel,street,city,postal,phone,website,email,instagram_url,facebook_url,linkedin_url," +
  "lifecycle,last_order_at,lifetime_revenue,trailing_12m_revenue,expected_reorder_at,quirks,current_state,future_state,impact," +
  "business_hours,hubspot_company_id,potential_hq,potential_juan";

export async function getClientAccount(id: string): Promise<ClientAccount | null> {
  const rows = await sbGet<ClientAccount>("nb_accounts", { select: CLIENT_ACCOUNT_SELECT, id: `eq.${id}`, limit: "1" });
  return rows[0] ?? null;
}

/** Just the name, for a page title. */
export async function getClientAccountName(id: string): Promise<string | null> {
  const rows = await sbGet<{ name: string }>("nb_accounts", { select: "name", id: `eq.${id}`, limit: "1" });
  return rows[0]?.name ?? null;
}

export type ClientContact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  role_tag: string | null;
  is_decision_maker: boolean;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
};

export async function listClientContacts(accountId: string): Promise<ClientContact[]> {
  return sbGet<ClientContact>("nb_contacts", {
    select: "*",
    account_id: `eq.${accountId}`,
    order: "is_decision_maker.desc,last_name.asc",
  });
}

export type ClientActivity = {
  id: number;
  at: string;
  kind: string;
  direction: string | null;
  outcome: string | null;
  detail: string | null;
};

/** Internal rows (corrections, geocode and import notes) never happened with the client. */
export async function listClientActivities(accountId: string): Promise<ClientActivity[]> {
  const rows = await sbGet<ClientActivity>("nb_activities", {
    select: "id,at,kind,direction,outcome,detail",
    account_id: `eq.${accountId}`,
    order: "at.desc",
    limit: "60",
  });
  return rows.filter((a) => a.direction !== "internal");
}
