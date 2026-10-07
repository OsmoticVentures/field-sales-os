/**
 * THE CLIENT VIEW'S DATA, assembled once on the server and kept on the phone.
 * Everything the client view paints (account, contacts, activities, orders,
 * the tier letter and score) is one JSON-serializable AccountPayload, built by
 * the same code whether it is one client (a miss, or a refresh after a write)
 * or the whole book at once (the twice-daily download, see
 * lib/core/phone-sync.ts). The bits that move by the minute, the route draft
 * and the SDR queue, are not in it: readAccountLive() reads those fresh every
 * time a client opens.
 *
 * Bulk on purpose: the book is five paged reads (accounts, contacts,
 * activities, orders, lines) plus the priority book, never eight reads per
 * client.
 */
import "server-only";
import { myOwnerId } from "../../core/user";
import { getPriorityBook, listAccountSdrQueue, type PurchaseLine, type PurchaseOrder } from "../prospect/dal";
import { getRouteStateByDay, isConfigured as routeConfigured } from "../route/dal";
import { dayLabel } from "../route/field-week";
import type { RouteDraftEntry } from "../route/types";
import type { ClientAccount, ClientActivity, ClientContact } from "./dal";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const configured = (): boolean => Boolean(SB_URL && SB_KEY);

/** The signed-in rep's working book: owned, not chain/practice-excluded, open, not a waypoint. */
const book = async () => ({
  hubspot_owner_id: `eq.${await myOwnerId()}`,
  chain_excluded: "eq.false",
  practice_excluded: "eq.false",
  closed_at: "is.null",
  lifecycle: "neq.waypoint",
});

/** Per client, the same caps the single-client reads always used. */
const ACTIVITY_CAP = 60;
const ORDER_CAP = 500;

export type AccountPayload = {
  account: ClientAccount;
  contacts: ClientContact[];
  activities: ClientActivity[];
  orders: PurchaseOrder[];
  lines: PurchaseLine[];
  initialTier: string | null;
  tierIsMine: boolean;
  score: number | null;
  warmth: string | null;
  leadStatus: string | null;
  /** When the server assembled it, ISO. */
  builtAt: string;
};

/** One open SDR entry, as TierButton lists it. */
export type SdrEntry = { kind: string; date: string; label: string };

export type AccountLive = {
  routeDraftByDay: Record<string, RouteDraftEntry[]>;
  sdr: SdrEntry[];
};

const ACCOUNT_KEYS: (keyof ClientAccount)[] = [
  "id",
  "name",
  "channel",
  "street",
  "city",
  "postal",
  "phone",
  "website",
  "email",
  "instagram_url",
  "facebook_url",
  "linkedin_url",
  "lifecycle",
  "last_order_at",
  "lifetime_revenue",
  "trailing_12m_revenue",
  "expected_reorder_at",
  "quirks",
  "current_state",
  "future_state",
  "impact",
  "business_hours",
  "hubspot_company_id",
  "potential_hq",
  "potential_juan",
];

const CONTACT_KEYS: (keyof ClientContact)[] = [
  "id",
  "first_name",
  "last_name",
  "title",
  "role_tag",
  "is_decision_maker",
  "email",
  "phone",
  "linkedin_url",
];

type Row = Record<string, unknown>;

function pick<T>(row: Row, keys: (keyof T)[]): T {
  const out: Row = {};
  for (const k of keys) if (row[k as string] !== undefined) out[k as string] = row[k as string];
  return out as T;
}

async function sbGet<T>(table: string, params: URLSearchParams): Promise<T[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
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

/**
 * Every row matching `params`, for the given account ids. PostgREST caps a
 * response at 1,000 rows, so each chunk of ids pages until a short page
 * (orders and lines both hit exactly 1,000 on the book). Ids go in chunks so
 * the in.(...) list never makes an overlong URL. `order` must end in a unique
 * column for offsets to be stable.
 */
async function sbGetAllFor<T>(table: string, params: Record<string, string>, ids: string[]): Promise<T[]> {
  const CHUNK = 150;
  const MAX_PAGES = 100;
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
  const per = await Promise.all(
    chunks.map(async (chunk) => {
      const out: T[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const p = new URLSearchParams(params);
        p.set("account_id", chunk.length === 1 ? `eq.${chunk[0]}` : `in.(${chunk.join(",")})`);
        p.set("limit", "1000");
        p.set("offset", String(page * 1000));
        const rows = await sbGet<T>(table, p);
        out.push(...rows);
        if (rows.length < 1000) break;
      }
      return out;
    }),
  );
  return per.flat();
}

function groupBy<T extends { account_id: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const list = m.get(r.account_id);
    if (list) list.push(r);
    else m.set(r.account_id, [r]);
  }
  return m;
}

/** The payloads for these account rows (nb_accounts, select=*). */
async function assemble(accountRows: Row[]): Promise<Record<string, AccountPayload>> {
  const ids = accountRows.map((a) => String(a.id));
  if (ids.length === 0) return {};

  const [contacts, activities, orders, lines, book] = await Promise.all([
    sbGetAllFor<Row & { account_id: string }>(
      "nb_contacts",
      { select: "*", order: "account_id.asc,is_decision_maker.desc,last_name.asc,id.asc" },
      ids,
    ),
    // Internal rows (corrections, geocode and import notes) never happened
    // with the client. A null direction is a real touch, so not neq alone.
    sbGetAllFor<ClientActivity & { account_id: string }>(
      "nb_activities",
      {
        select: "id,account_id,at,kind,direction,outcome,detail",
        or: "(direction.is.null,direction.neq.internal)",
        order: "account_id.asc,at.desc,id.desc",
      },
      ids,
    ),
    sbGetAllFor<PurchaseOrder & { account_id: string }>(
      "nb_orders",
      { select: "id,account_id,ordered_at,revenue_cents", order: "account_id.asc,ordered_at.desc,id.asc" },
      ids,
    ),
    sbGetAllFor<PurchaseLine & { account_id: string }>(
      "nb_order_lines",
      {
        select: "account_id,order_id,product_name,qty,line_revenue_cents",
        order: "account_id.asc,order_id.asc,product_name.asc,qty.asc,line_revenue_cents.asc",
      },
      ids,
    ),
    getPriorityBook().catch(() => null),
  ]);

  const contactsBy = groupBy(contacts);
  const activitiesBy = groupBy(activities);
  const ordersBy = groupBy(orders);
  const linesBy = groupBy(lines);
  const builtAt = new Date().toISOString();

  const out: Record<string, AccountPayload> = {};
  for (const row of accountRows) {
    const id = String(row.id);
    const account = pick<ClientAccount>(row, ACCOUNT_KEYS);
    const prio = book?.byId.get(id);
    const accOrders = (ordersBy.get(id) ?? []).slice(0, ORDER_CAP).map(({ id, ordered_at, revenue_cents }) => ({ id, ordered_at, revenue_cents }));
    const orderIds = new Set(accOrders.map((o) => o.id));
    out[id] = {
      account,
      contacts: (contactsBy.get(id) ?? []).map((c) => pick<ClientContact>(c, CONTACT_KEYS)),
      activities: (activitiesBy.get(id) ?? [])
        .slice(0, ACTIVITY_CAP)
        .map(({ id, at, kind, direction, outcome, detail }) => ({ id, at, kind, direction, outcome, detail })),
      orders: accOrders,
      lines: accOrders.length
        ? (linesBy.get(id) ?? [])
            .filter((l) => orderIds.has(l.order_id))
            .map(({ order_id, product_name, qty, line_revenue_cents }) => ({ order_id, product_name, qty, line_revenue_cents }))
        : [],
      initialTier: account.potential_juan ?? prio?.grade ?? (account.potential_hq ? account.potential_hq.split(" ")[0] || null : null),
      tierIsMine: Boolean(account.potential_juan),
      score: prio?.score ?? null,
      warmth: (row.readiness as string | null | undefined) ?? null,
      leadStatus: (row.lead_status as string | null | undefined) ?? null,
      builtAt,
    };
  }
  return out;
}

/** One client, fresh. Null when there is no such account. */
export async function readAccountPayload(id: string): Promise<AccountPayload | null> {
  if (!configured()) return null;
  const rows = await sbGet<Row>("nb_accounts", new URLSearchParams({ select: "*", id: `eq.${id}`, limit: "1" }));
  if (rows.length === 0) return null;
  return (await assemble(rows))[id] ?? null;
}

/** Every client in Juan's working book, keyed by id. */
export async function readBookPayloads(): Promise<Record<string, AccountPayload>> {
  if (!configured()) return {};
  const rows: Row[] = [];
  for (let page = 0; page < 20; page++) {
    const p = new URLSearchParams({ select: "*", ...(await book()), order: "id.asc", limit: "1000", offset: String(page * 1000) });
    const batch = await sbGet<Row>("nb_accounts", p);
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return assemble(rows);
}

/** The route draft by day, and this client's open SDR entries when `id` is given. */
export async function readAccountLive(id: string | null): Promise<AccountLive> {
  const [routeState, sdrQueue] = await Promise.all([
    routeConfigured() ? getRouteStateByDay() : Promise.resolve(null),
    id ? listAccountSdrQueue(id).catch(() => []) : Promise.resolve([]),
  ]);
  return {
    routeDraftByDay: routeState?.draft ?? {},
    sdr: sdrQueue.map((e) => {
      const { weekday, short } = dayLabel(e.scheduled_date);
      return { kind: e.kind, date: e.scheduled_date, label: `${e.kind === "visit" ? "Visit" : "Call"} ${weekday} ${short}` };
    }),
  };
}
