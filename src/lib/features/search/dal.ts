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
import { myOwnerId } from "../../core/user";
import { maxAttemptsFor, runLapsed } from "./lease";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const configured = (): boolean => Boolean(SB_URL && SB_KEY);


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
// response; the browser polls the row. A claim is predicated on
// status=pending, so two runners (this app, the minute drain, the old Mac
// worker while it is still loaded) can never both run one job.
//
// DURABLE QUEUE (supabase/0002_durable_search_jobs.sql). With that migration
// in place a claim takes a lease and counts an attempt; a lapsed lease means
// the function died, and nb_sweep_search_jobs() puts the row back to pending
// while attempts remain or fails it in place when they are spent. pg_cron
// runs the sweep every minute inside Postgres and calls /api/jobs/drain only
// when a row is ready, so a job survives a closed tab and a dead function.
// Until the migration is applied, every function here falls back to the
// original lease-less behavior, so this code is safe either way.

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
  /** Present once the durable migration is applied. */
  attempts?: number;
  max_attempts?: number;
  lease_until?: string | null;
};

/* Is the durable schema there? Learned once per instance: a yes is kept for
   good, a no is asked again after five minutes, one zero-row read each time. */
let durableKnown: { at: number; yes: boolean } | null = null;
const DURABLE_RECHECK_MS = 5 * 60_000;

export async function durableQueue(): Promise<boolean> {
  if (durableKnown && (durableKnown.yes || Date.now() - durableKnown.at < DURABLE_RECHECK_MS)) {
    return durableKnown.yes;
  }
  if (!configured()) return false;
  const res = await fetch(`${SB_URL}/rest/v1/${JOBS}?select=lease_until&limit=0`, {
    headers: sbHeaders(),
    cache: "no-store",
  }).catch(() => null);
  const yes = Boolean(res?.ok);
  durableKnown = { at: Date.now(), yes };
  return yes;
}

async function sbRpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (!configured()) throw new Error(`Cannot call "${fn}": no data source configured.`);
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: sbHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase rpc ${fn} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** Queue one stage. Returns the id the browser polls. */
export async function createSearchJob(
  stage: SearchJobStage,
  params: Record<string, unknown>,
): Promise<string> {
  const id = randId("sj");
  const row: Record<string, unknown> = { id, stage, params, status: "pending" };
  if (await durableQueue()) row.max_attempts = maxAttemptsFor(stage, params);
  await sbInsert(JOBS, row);
  return id;
}

const STATUS_COLS = "id,stage,status,error,created_at,started_at,updated_at";

/** Everything about a job except its result. The poll. */
export async function getSearchJobStatus(id: string): Promise<SearchJob | null> {
  const durable = await durableQueue();
  const rows = await sbGet<SearchJob>(JOBS, {
    select: durable ? `${STATUS_COLS},attempts,max_attempts,lease_until` : STATUS_COLS,
    id: `eq.${encodeURIComponent(id)}`,
    limit: "1",
  });
  return rows[0] ?? null;
}

/** The stage's own summary, verbatim, fetched once the status says it exists. */
export async function getSearchJobResult(id: string): Promise<Record<string, unknown> | null> {
  const rows = await sbGet<{ result: Record<string, unknown> | null }>(JOBS, {
    select: "result",
    id: `eq.${encodeURIComponent(id)}`,
    limit: "1",
  });
  return rows[0]?.result ?? null;
}

/** Oldest ready jobs first, ids only. The drain's one read. */
export async function listPendingJobIds(limit: number): Promise<string[]> {
  const rows = await sbGet<{ id: string }>(JOBS, {
    select: "id",
    status: "eq.pending",
    order: "created_at.asc",
    limit: String(limit),
  });
  return rows.map((r) => r.id);
}

/** Recover runs whose function died (durable schema only). Returns how many
 *  rows are ready to run. */
export async function sweepSearchJobs(): Promise<number> {
  return sbRpc<number>("nb_sweep_search_jobs", {});
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
      hubspot_owner_id: `eq.${await myOwnerId()}`,
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
    hubspot_owner_id: `eq.${await myOwnerId()}`,
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

export type ClaimedJob = {
  id: string;
  stage: SearchJobStage;
  params: Record<string, unknown> | string | null;
  attempts?: number;
  max_attempts?: number;
};

/** A lease a little past the route's maxDuration (300s): a live run never
 *  loses its row, and a dead one is noticed within a minute of its function
 *  being killed. */
const LEASE_SECONDS = 330;

/** Take the job, or learn somebody else already did. */
export async function claimSearchJob(id: string): Promise<ClaimedJob | null> {
  if (await durableQueue()) {
    const rows = await sbRpc<ClaimedJob[]>("nb_claim_search_job", { p_id: id, p_lease_seconds: LEASE_SECONDS });
    return rows[0] ?? null;
  }
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
  if (await durableQueue()) body.lease_until = null;
  await sbPatch(JOBS, { id: `eq.${id}` }, body, false);
}

/** Put a running job back in the queue after a passing failure (durable
 *  schema only; the caller has checked attempts remain). */
export async function requeueSearchJob(id: string): Promise<void> {
  await sbPatch(JOBS, { id: `eq.${id}`, status: "eq.running" }, { status: "pending", lease_until: null }, false);
}

/** Without the durable schema: a run left going past 20 minutes was
 *  interrupted; fail it rather than leave it spinning. With it, the sweep
 *  does this (and retries first). */
export async function failIfStale(job: SearchJob): Promise<boolean> {
  if (!runLapsed(job)) return false;
  if (await durableQueue()) {
    await sweepSearchJobs();
    return true;
  }
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
// The minute drain's shared secret (nb_job_runner, durable schema only)
// ---------------------------------------------------------------------------

let runnerSecret: { at: number; value: string | null } | null = null;
const SECRET_TTL_MS = 10 * 60_000;

/** The secret pg_cron sends in x-nb-runner. Read at most every ten minutes. */
export async function jobRunnerSecret(): Promise<string | null> {
  if (runnerSecret && Date.now() - runnerSecret.at < SECRET_TTL_MS) return runnerSecret.value;
  const rows = await sbGet<{ secret: string }>("nb_job_runner", { select: "secret", id: "eq.1", limit: "1" }).catch(
    () => [],
  );
  runnerSecret = { at: Date.now(), value: rows[0]?.secret ?? null };
  return runnerSecret.value;
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

// ---- Search exclusions shortlist (nb_search_exclusions) ----

export type ExclusionKind = "chain" | "category";
const EXCLUSIONS = "nb_search_exclusions";
const EXCLUSIONS_CAP = 60;

/** Newest first, at most EXCLUSIONS_CAP per kind. One small read on mount. */
export async function listExclusions(kind: ExclusionKind): Promise<string[]> {
  const rows = await sbGet<{ value: string }>(EXCLUSIONS, {
    select: "value",
    kind: `eq.${kind}`,
    order: "last_used.desc",
    limit: String(EXCLUSIONS_CAP),
  });
  return rows.map((r) => r.value);
}

/** Upsert by (kind, lowercase value), then prune past the cap. */
export async function rememberExclusions(kind: ExclusionKind, values: string[]): Promise<void> {
  const now = new Date().toISOString();
  const byNorm = new Map<string, { kind: ExclusionKind; norm: string; value: string; last_used: string }>();
  for (const raw of values) {
    const value = raw.trim().slice(0, 80);
    if (value) byNorm.set(value.toLowerCase(), { kind, norm: value.toLowerCase(), value, last_used: now });
  }
  if (byNorm.size === 0) return;
  const res = await fetch(`${SB_URL}/rest/v1/${EXCLUSIONS}?on_conflict=kind,norm`, {
    method: "POST",
    headers: sbHeaders({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify([...byNorm.values()]),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase ${EXCLUSIONS} upsert -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const keep = await sbGet<{ norm: string }>(EXCLUSIONS, {
    select: "norm",
    kind: `eq.${kind}`,
    order: "last_used.desc",
    offset: String(EXCLUSIONS_CAP),
    limit: "200",
  });
  for (const r of keep) await sbDelete(EXCLUSIONS, { kind: `eq.${kind}`, norm: `eq.${r.norm}` });
}

// ---- Hidden businesses (nb_search_hidden) ----

/** Places ids Juan has X'd out of Search. Ids only, a few bytes each. */
export async function listHiddenPlaceIds(): Promise<string[]> {
  const rows = await sbGet<{ places_id: string }>("nb_search_hidden", { select: "places_id", limit: "10000" });
  return rows.map((r) => r.places_id);
}

export async function hidePlace(placesId: string, name: string | null): Promise<void> {
  const res = await fetch(`${SB_URL}/rest/v1/nb_search_hidden?on_conflict=places_id`, {
    method: "POST",
    headers: sbHeaders({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify([{ places_id: placesId, name: name ? name.slice(0, 160) : null }]),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase nb_search_hidden upsert -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// ---- Groups (nb_search_groups, nb_search_group_members) ----

export type GroupMember = { places_id: string; name: string | null; candidate: Record<string, unknown>; added_at: string };
export type SearchGroup = { id: string; name: string; members: GroupMember[] };

export async function listGroups(): Promise<SearchGroup[]> {
  const [groups, members] = await Promise.all([
    sbGet<{ id: string; name: string }>("nb_search_groups", { select: "id,name", order: "created_at.asc" }),
    sbGet<GroupMember & { group_id: string }>("nb_search_group_members", {
      select: "group_id,places_id,name,candidate,added_at",
      order: "added_at.desc",
      limit: "5000",
    }),
  ]);
  return groups.map((g) => ({ ...g, members: members.filter((m) => m.group_id === g.id) }));
}

export async function createGroup(name: string): Promise<SearchGroup> {
  const clean = name.trim().slice(0, 80);
  const id =
    clean
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || `group-${Date.now()}`;
  const res = await fetch(`${SB_URL}/rest/v1/nb_search_groups?on_conflict=id`, {
    method: "POST",
    headers: sbHeaders({ "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" }),
    body: JSON.stringify([{ id, name: clean }]),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase nb_search_groups insert -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return { id, name: clean, members: [] };
}

export async function addGroupMembers(
  groupId: string,
  members: { places_id: string; name: string | null; candidate: Record<string, unknown> }[],
): Promise<void> {
  if (!members.length) return;
  const res = await fetch(`${SB_URL}/rest/v1/nb_search_group_members?on_conflict=group_id,places_id`, {
    method: "POST",
    headers: sbHeaders({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(members.map((m) => ({ ...m, group_id: groupId, added_at: new Date().toISOString() }))),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase nb_search_group_members upsert -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

export async function removeGroupMember(groupId: string, placesId: string): Promise<void> {
  await sbDelete("nb_search_group_members", { group_id: `eq.${groupId}`, places_id: `eq.${placesId}` });
}
