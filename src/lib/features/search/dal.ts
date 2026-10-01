/**
 * Search Map's own data slice: the nb_search_jobs queue, the book reads the
 * pipeline de-dups against, and the landing inserts. Ported from
 * portfolio/src/app/nutribiotic/lib/dal.ts's nb_search_jobs section and its
 * listAccountsForMatching/listBookPlaces reads, plus the sb helpers
 * bridges/nutribiotic/search_worker.py and lib/prospect_land.py used.
 *
 * The pipeline itself (pipeline.ts) runs on Vercel, right after the job row
 * is written, so a search no longer waits on Juan's Mac.
 */
import "server-only";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const configured = (): boolean => Boolean(SB_URL && SB_KEY);

const JUAN_OWNER_ID = "36242368";

async function sbGet<T>(table: string, params: Record<string, string>): Promise<T[]> {
  if (!configured()) return [];
  const qs = new URLSearchParams(params);
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase ${table} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T[];
}

const JOBS = "nb_search_jobs";

function sbHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, ...extra };
}

async function sbPatch<T>(table: string, filters: Record<string, string>, body: unknown, returnRows: boolean): Promise<T[]> {
  if (!configured()) throw new Error(`Cannot write to "${table}": no data source configured.`);
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${new URLSearchParams(filters)}`, {
    method: "PATCH",
    headers: sbHeaders({ "Content-Type": "application/json", Prefer: returnRows ? "return=representation" : "return=minimal" }),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase ${table} PATCH -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return returnRows ? ((await res.json()) as T[]) : [];
}

async function sbDelete(table: string, filters: Record<string, string>): Promise<void> {
  if (!configured()) return;
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${new URLSearchParams(filters)}`, {
    method: "DELETE",
    headers: sbHeaders({ Prefer: "return=minimal" }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase ${table} DELETE -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export function isConfigured(): boolean {
  return configured();
}

async function sbInsert(table: string, body: unknown): Promise<void> {
  if (!configured()) throw new Error(`Cannot write to "${table}": no data source configured.`);
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Supabase ${table} POST -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

/** Our own id shape throughout this schema: '<prefix>_<6 hex>'. */
function randId(prefix: string): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------------------------------------------------------------------
// nb_search_jobs · the Search screen's queue
// ---------------------------------------------------------------------------
//
// The POST route writes a pending row and runs it (worker.ts) right after the
// response; the browser polls the row. A claim is a PATCH predicated on
// status=pending, so two runners (this app and the old Mac worker, while it
// is still loaded) can never both run one job.

export type SearchJobStage = "search" | "enrich" | "land";
export type SearchJobStatus = "pending" | "running" | "done" | "error";

export type SearchJob = {
  id: string;
  stage: SearchJobStage;
  status: SearchJobStatus;
  error: string | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
};

/** Queue one stage. Returns the id the browser polls. */
export async function createSearchJob(
  stage: SearchJobStage,
  params: Record<string, unknown>,
): Promise<string> {
  const id = randId("sj");
  await sbInsert(JOBS, { id, stage, params, status: "pending" });
  return id;
}

/** Everything about a job except its result. The poll. */
export async function getSearchJobStatus(id: string): Promise<SearchJob | null> {
  const rows = await sbGet<SearchJob>("nb_search_jobs", {
    select: "id,stage,status,error,created_at,started_at,updated_at",
    id: `eq.${encodeURIComponent(id)}`,
    limit: "1",
  });
  return rows[0] ?? null;
}

/** The stage's own summary, verbatim, fetched once the status says it exists. */
export async function getSearchJobResult(id: string): Promise<Record<string, unknown> | null> {
  const rows = await sbGet<{ result: Record<string, unknown> | null }>("nb_search_jobs", {
    select: "result",
    id: `eq.${encodeURIComponent(id)}`,
    limit: "1",
  });
  return rows[0]?.result ?? null;
}

// ---------------------------------------------------------------------------
// The book, for "Search our book" (finding an account already in the book)
// ---------------------------------------------------------------------------

export type BookAccount = { id: string; name: string; area: string | null; tier: string | null };

/** Every account in Juan's book a search could match against: owned, not
 *  closed, not a waypoint. No ceiling: this is "every real account". */
export async function listAccountsForMatching(): Promise<BookAccount[]> {
  const rows = await sbGet<{ account_id: string; name: string; area: string | null; tier: string | null }>(
    "nb_v_account_tier",
    {
      select: "account_id,name,area,tier",
      hubspot_owner_id: `eq.${JUAN_OWNER_ID}`,
      closed_at: "is.null",
      lifecycle: "neq.waypoint",
    },
  );
  return rows.map((r) => ({ id: r.account_id, name: r.name, area: r.area, tier: r.tier }));
}

export type BookPlace = { id: string; city: string | null; state: string | null };

/** Where each account in the book is, since the tier view carries no city. */
export async function listBookPlaces(): Promise<BookPlace[]> {
  return sbGet<BookPlace>("nb_accounts", {
    select: "id,city,state",
    hubspot_owner_id: `eq.${JUAN_OWNER_ID}`,
    closed_at: "is.null",
  });
}

export type BookPerson = { id: string; account_id: string; name: string };

/** Every named person on an account in the book, paged past PostgREST's
 *  1000-row ceiling. The caller keeps only those whose account is in the book. */
export async function listBookPeople(): Promise<BookPerson[]> {
  const out: BookPerson[] = [];
  const PAGE = 1000;
  for (let offset = 0; offset < 20_000; offset += PAGE) {
    const rows = await sbGet<{ id: string; account_id: string; first_name: string | null; last_name: string | null }>(
      "nb_contacts",
      {
        select: "id,account_id,first_name,last_name",
        order: "id.asc",
        limit: String(PAGE),
        offset: String(offset),
      },
    );
    for (const r of rows) {
      const name = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
      if (name) out.push({ id: r.id, account_id: r.account_id, name });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The runner's side of the queue
// ---------------------------------------------------------------------------

export type ClaimedJob = { id: string; stage: SearchJobStage; params: Record<string, unknown> | string | null };

/** Take the job, or learn somebody else already did. */
export async function claimSearchJob(id: string): Promise<ClaimedJob | null> {
  const rows = await sbPatch<ClaimedJob>(
    JOBS,
    { id: `eq.${id}`, status: "eq.pending" },
    { status: "running", started_at: new Date().toISOString() },
    true,
  );
  return rows[0] ?? null;
}

export async function finishSearchJob(id: string, done: { result?: unknown; error?: string }): Promise<void> {
  const body: Record<string, unknown> = { status: done.error ? "error" : "done" };
  if (done.result !== undefined) body.result = done.result;
  if (done.error !== undefined) body.error = done.error.slice(0, 2000);
  await sbPatch(JOBS, { id: `eq.${id}` }, body, false);
}

/** A job left running past this was interrupted; it is failed rather than
 *  left spinning, since the screen has no other way to learn that. */
const STALE_RUNNING_MIN = 20;

export async function failIfStale(job: SearchJob): Promise<boolean> {
  if (job.status !== "running" || !job.started_at) return false;
  if (Date.now() - Date.parse(job.started_at) < STALE_RUNNING_MIN * 60_000) return false;
  const rows = await sbPatch<{ id: string }>(
    JOBS,
    { id: `eq.${job.id}`, status: "eq.running" },
    { status: "error", error: "This run was interrupted before it finished, and its result was never recorded. Run it again." },
    true,
  );
  return rows.length > 0;
}

/** The table's bound: finished rows older than three days. */
const RETENTION_DAYS = 3;

export async function pruneSearchJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  await sbDelete(JOBS, { status: "in.(done,error)", updated_at: `lt.${cutoff}` });
}

// ---------------------------------------------------------------------------
// The book, for the pipeline's de-dup, and the landing inserts
// ---------------------------------------------------------------------------

export type LocalAccount = {
  id: string;
  name: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  postal: string | null;
  places_id: string | null;
  source: string | null;
  source_external_id: string | null;
  hubspot_company_id: string | null;
  lifecycle: string | null;
  erp_customer_code: string | null;
};

const LOCAL_COLS =
  "id,name,phone,street,city,postal,places_id,source,source_external_id,hubspot_company_id,lifecycle,erp_customer_code";

/** Every account, narrow select, paged (prospect_land.load_local). */
export async function loadLocalAccounts(): Promise<LocalAccount[]> {
  const out: LocalAccount[] = [];
  for (let page = 0; ; page++) {
    const rows = await sbGet<LocalAccount>("nb_accounts", {
      select: LOCAL_COLS,
      order: "id.asc",
      limit: "1000",
      offset: String(page * 1000),
    });
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export async function insertRows(table: "nb_accounts" | "nb_sdr_schedule", rows: unknown[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    await sbInsert(table, rows.slice(i, i + 200));
  }
}

export { randId };
