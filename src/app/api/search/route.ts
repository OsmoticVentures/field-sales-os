/**
 * The Search screen's three actions. This route validates one and queues it.
 *
 * THIS ROUTE OWNS NO SEARCH LOGIC. Every filter, the triage weights, the
 * point-in-polygon test, the territory test, the book de-dup, the chain
 * regex plus curated exclude list, and the landing spread all live in
 * bridges/nutribiotic/places_search_ingest.py, on Juan's Mac. That is
 * unchanged by this port: Vercel has no Python and no bridges/ directory, so
 * this route never runs a search itself. Ported from
 * portfolio/src/app/nutribiotic/api/search/route.ts.
 *
 *   POST /nb/api/search   validates the request, inserts one pending row in
 *                         nb_search_jobs, returns { job } immediately.
 *   bridges/nutribiotic/search_worker.py, on Juan's Mac under launchd, claims
 *                         the row, runs the stage locally, writes the answer
 *                         back onto the row. Unchanged by this port.
 *   GET  /nb/api/search?job=id   the browser polls this until the row says
 *                         done or error.
 *
 * IDEMPOTENCY, ADDED FOR THIS REPO (the source app has none, per PORTING.md).
 * The queue insert is the write, so a re-tap of the same click (a dropped
 * response, a double tap) reuses the same job id rather than opening a
 * second run; the client generates one key per click and does not reuse it
 * across a different click.
 */
import { hasAccess } from "../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../lib/core/idempotency";
import {
  createSearchJob,
  getSearchJobResult,
  getSearchJobStatus,
  type SearchJobStage,
} from "../../../lib/features/search/dal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A bound on one search. The worker reports `capped_off` when it bites, so a
 *  truncated list says so on screen rather than looking like the whole answer. */
const MAX_CANDIDATES = 60;

/** The bound on a "Find all" run: the worker keeps splitting a box still at
 *  Google's 60-result ceiling until none of it is, so the point of the click
 *  is a complete list, not a sample. Still a real cap. */
const MAX_CANDIDATES_DEEP = 300;

/** A bound on what one click can spend and one click can append. */
const MAX_ENRICH = 25;
const MAX_LAND = 25;

/** As many pins as anyone wants, within reason. */
const MAX_PINS = 200;

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Short, human-typed phrases (excluded categories, chain names). Trimmed,
 *  deduped, blanks dropped, capped. */
function phrases(v: unknown, cap: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const s = String(raw ?? "").trim().slice(0, maxLen);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

/** Candidate records, passed straight back through to the worker. Only
 *  checked here for shape: an object carrying the `key` the worker assigns. */
function candidates(v: unknown, cap: number): Record<string, unknown>[] | null {
  if (!Array.isArray(v)) return null;
  if (v.length === 0 || v.length > cap) return null;
  const out: Record<string, unknown>[] = [];
  for (const c of v) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return null;
    const rec = c as Record<string, unknown>;
    if (typeof rec.key !== "string" || !rec.key) return null;
    out.push(rec);
  }
  return out;
}

/**
 * POST · queue one stage. Validation happens here, at the door, before
 * anything is written: a request that cannot be run should never become a
 * row the worker has to fail.
 */
export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const key = idempotencyKey(req);
  if (!key) {
    return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Expected a JSON body." }, { status: 400 });
  }

  const stage = String(body.stage ?? "search") as SearchJobStage;
  if (stage !== "search" && stage !== "enrich" && stage !== "land") {
    return Response.json({ ok: false, error: `Unknown stage ${stage}.` }, { status: 400 });
  }

  let params: Record<string, unknown>;

  if (stage === "search") {
    const category = String(body.category ?? "").trim().slice(0, 120);
    if (!category) {
      return Response.json({ ok: false, error: "Say what to search for." }, { status: 400 });
    }

    const raw = Array.isArray(body.polygon) ? body.polygon : [];
    const polygon: [number, number][] = [];
    for (const p of raw.slice(0, MAX_PINS)) {
      const pt = p as { lat?: unknown; lng?: unknown };
      const lat = Number(pt?.lat);
      const lng = Number(pt?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      polygon.push([lat, lng]);
    }
    if (polygon.length < 3) {
      return Response.json(
        { ok: false, error: "Drop at least three pins to close an area first." },
        { status: 400 },
      );
    }

    params = {
      category,
      polygon,
      min_review_count: Math.round(num(body.min_review_count, 30, 0, 5000)),
      min_rating: num(body.min_rating, 4.0, 0, 5),
      require_phone: bool(body.require_phone, true),
      require_website: bool(body.require_website, true),
      min_triage_score: num(body.min_triage_score, 45, 0, 100),
      included_type:
        typeof body.included_type === "string" ? body.included_type.slice(0, 60) : "auto",
      exclude_categories: phrases(body.exclude_categories, 40, 60),
      chain_exclude: bool(body.chain_exclude, false),
      chain_names: phrases(body.chain_names, 40, 80),
      min_photos: Math.round(num(body.min_photos, 0, 0, 200)),
      max_per_sq_mile: Math.round(num(body.max_per_sq_mile, 0, 0, 100)),
      open_day:
        typeof body.open_day === "number" && typeof body.open_time === "string"
          ? Math.round(num(body.open_day, 0, 0, 6))
          : null,
      open_time:
        typeof body.open_time === "string" && typeof body.open_day === "number"
          ? body.open_time.trim().slice(0, 5)
          : null,
      deep: body.deep === true,
      max_candidates: body.deep === true ? MAX_CANDIDATES_DEEP : MAX_CANDIDATES,
    };
  } else if (stage === "enrich") {
    const picked = candidates(body.candidates, MAX_ENRICH);
    if (!picked) {
      return Response.json(
        { ok: false, error: `Pick between 1 and ${MAX_ENRICH} rows to look further into.` },
        { status: 400 },
      );
    }
    params = { candidates: picked, site_pages: Math.round(num(body.site_pages, 4, 1, 8)) };
  } else {
    const category = String(body.category ?? "").trim().slice(0, 120);
    const picked = candidates(body.candidates, MAX_LAND);
    if (!picked) {
      return Response.json(
        { ok: false, error: `Pick between 1 and ${MAX_LAND} rows to add.` },
        { status: 400 },
      );
    }
    params = {
      category,
      candidates: picked,
      calls_per_day: Math.round(num(body.calls_per_day, 15, 1, 50)),
      write: body.write === true,
    };
  }

  try {
    const { result: job, replayed } = await withIdempotency(`search:${key}`, () =>
      createSearchJob(stage, params),
    );
    return Response.json(
      { ok: true, stage, job, replayed, status: "pending", limits: { MAX_CANDIDATES, MAX_ENRICH, MAX_LAND } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, stage, error: "Could not queue the run. Nothing ran." },
      { status: 502 },
    );
  }
}

/**
 * GET · what has happened to a queued job. `?job=<id>`. The result is
 * fetched only once the status says it exists, in a second query: a finished
 * search carries around 60 candidate records, and re-shipping that on every
 * poll is real egress for no reason.
 */
export async function GET(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const id = new URL(req.url).searchParams.get("job") ?? "";
  if (!id) {
    return Response.json({ ok: false, error: "Which job?" }, { status: 400 });
  }

  let row;
  try {
    row = await getSearchJobStatus(id);
  } catch {
    return Response.json({ ok: false, error: "Could not read the run's status." }, { status: 502 });
  }
  if (!row) {
    return Response.json({ ok: false, error: "No such run." }, { status: 404 });
  }

  const base = {
    job: row.id,
    stage: row.stage,
    status: row.status,
    created_at: row.created_at,
    started_at: row.started_at,
    updated_at: row.updated_at,
  };

  if (row.status === "pending" || row.status === "running") {
    return Response.json({ ok: true, ...base }, { headers: { "cache-control": "no-store" } });
  }

  if (row.status === "error") {
    return Response.json(
      { ok: false, ...base, error: row.error ?? "The run failed on the Mac.", errors: [], candidates: [] },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const result = await getSearchJobResult(id);
  if (!result) {
    return Response.json(
      { ok: false, ...base, error: "The run finished without recording a summary.", errors: [], candidates: [] },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(
    { ...result, ...base, limits: { MAX_CANDIDATES, MAX_ENRICH, MAX_LAND } },
    { headers: { "cache-control": "no-store" } },
  );
}
