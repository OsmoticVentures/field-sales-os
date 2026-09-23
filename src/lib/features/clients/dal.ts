/**
 * Data access for Clients (/clients) and the client view (/account/[id]).
 * Ported from the source app's lib/dal.ts: listAccounts, listAreas,
 * getAccountHoursMap, listDeals, listStaleDeals, listTerritoryAccountIds,
 * getAccount, listActivities, listContacts. Purchases reuse
 * lib/features/prospect/dal.ts's listPurchases.
 */
import "server-only";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

export const isConfigured = (): boolean => Boolean(SB_URL && SB_KEY);

const JUAN_OWNER_ID = "36242368";

/** Juan's working book: owned, not chain/practice-excluded, open, not a waypoint. */
const BOOK = {
  hubspot_owner_id: `eq.${JUAN_OWNER_ID}`,
  chain_excluded: "eq.false",
  practice_excluded: "eq.false",
  closed_at: "is.null",
  lifecycle: "neq.waypoint",
};

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

export type TierRow = {
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

export async function listClientAccounts(opts: { area?: string | null; sort?: "tier" | "engagement" } = {}): Promise<TierRow[]> {
  const params: Record<string, string> = {
    select: "*",
    ...BOOK,
    order: opts.sort === "engagement" ? "engagement.desc.nullslast,tier.asc" : "tier.asc,fit_confidence.desc,fit.desc",
    limit: "500",
  };
  if (opts.area) params.area = `eq.${opts.area}`;
  return sbGet<TierRow>("nb_v_account_tier", params);
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

export type BusinessHours = Record<string, string[][]>;

export async function getAccountHoursMap(ids: string[]): Promise<Record<string, BusinessHours | null>> {
  if (ids.length === 0) return {};
  const rows = await sbGet<{ id: string; business_hours: BusinessHours | null }>("nb_accounts", {
    select: "id,business_hours",
    id: `in.(${ids.join(",")})`,
  });
  return Object.fromEntries(rows.map((a) => [a.id, a.business_hours]));
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

async function listTerritoryAccountIds(): Promise<Set<string>> {
  const rows = await sbGet<{ id: string }>("nb_accounts", { select: "id", ...BOOK, limit: "2000" });
  return new Set(rows.map((r) => r.id));
}

/** nb_deals and nb_v_pipeline_stale carry no owner, so both are filtered to Juan's book here. */
export async function listPipeline(): Promise<{ deals: Deal[]; stale: StaleDeal[] }> {
  const [deals, stale, ids] = await Promise.all([
    sbGet<Deal>("nb_deals", { select: "id,account_id,stage,next_step,next_step_date", order: "next_step_date.asc.nullslast", limit: "300" }),
    sbGet<StaleDeal>("nb_v_pipeline_stale", { select: "*", order: "next_step_days_overdue.desc.nullslast", limit: "150" }),
    listTerritoryAccountIds(),
  ]);
  return {
    deals: deals.filter((d) => ids.has(d.account_id)),
    stale: stale.filter((s) => ids.has(s.account_id)).slice(0, 20),
  };
}

export type ClientAccount = {
  id: string;
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

export async function getClientAccount(id: string): Promise<ClientAccount | null> {
  const rows = await sbGet<ClientAccount>("nb_accounts", { select: "*", id: `eq.${id}`, limit: "1" });
  return rows[0] ?? null;
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
