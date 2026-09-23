/**
 * Search Map's own data slice. Not the full lib/dal.ts (5,000+ lines, not
 * split yet, per PORTING.md and research/feature-inventory.md), just the
 * handful of reads and the one job-queue write this feature touches. Ported
 * from portfolio/src/app/nutribiotic/lib/dal.ts's nb_search_jobs section and
 * its listAccountsForMatching/listBookPlaces reads.
 *
 * THIS ROUTE OWNS NO SEARCH LOGIC. The Places search, the chain regex, the
 * curated exclude list, the validity gates and the landing spread all live in
 * bridges/nutribiotic/places_search_ingest.py, which keeps running unchanged
 * on Juan's Mac. This file only queues a job row and reads it back, same as
 * the source app since 2026-09-09: there is no Python and no bridges/
 * directory on Vercel, so the Next.js side never runs a search itself.
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
// nb_search_jobs · the Search screen's queue across the Mac boundary
// ---------------------------------------------------------------------------
//
// bridges/nutribiotic/search_worker.py, running on Juan's Mac under launchd,
// claims a pending row here, runs the pipeline locally and writes the answer
// back onto the same row. This app never runs a search itself.

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
  await sbInsert("nb_search_jobs", { id, stage, params, status: "pending" });
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
