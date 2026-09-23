/**
 * Reports data access, ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/dal.ts, the report-review section) with
 * only what this port needs, per PORTING.md. Talks to Supabase directly with
 * a plain fetch (same pattern as lib/core/devices.ts), because the shared
 * data layer (m5's split of the old lib/dal.ts) has not happened yet.
 *
 * WHAT STAYS ON THE MAC. field_report.py and weekly_report.py build the
 * payload and render the PDF (this app runs on Vercel, which has neither
 * Playwright nor python3). This module only reads what they already wrote to
 * nb_report_drafts and the nb-reports Storage bucket, and records a rebuild
 * or an edit as a row for the Mac-side poller to pick up.
 *
 * DECK-ONLY, NOT BUILT HERE. Cross-rep benchmarking and market intelligence
 * are deck claims with no code behind them anywhere in the source app
 * (research/feature-inventory.md, m1): a single shared PIN and no rep_id
 * column make comparing across reps structurally impossible today. Nothing
 * below reads or renders either.
 */
import "server-only";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const REPORTS_BUCKET = "nb-reports";

const configured = (): boolean => Boolean(SB_URL && SB_KEY);

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function raw<T>(path: string): Promise<T[]> {
  if (!configured()) return [];
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase read failed (${res.status}).`);
  return (await res.json()) as T[];
}

async function mutate(
  table: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
  match: Record<string, string> = {},
): Promise<void> {
  if (!configured()) throw new Error("No data source configured.");
  const params = new URLSearchParams(match);
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}${params.toString() ? `?${params}` : ""}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: method === "POST" ? "resolution=merge-duplicates,return=minimal" : "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase write failed (${res.status}).`);
}

/** All-time dashboard, /nb/reports (migration 0048). One row per metric,
 *  SUM(value) already done by nb_v_report_metrics_alltime. field_report.py
 *  writes the underlying rows every time it builds a day, so a correction to
 *  one day moves this total automatically. */
export type AllTimeMetrics = {
  visits: number;
  touchpoints: number;
  miles: number;
  daysWorked: number;
  newAccounts: number;
  accountsClosed: number;
  throughDate: string | null;
};

export async function getAllTimeMetrics(): Promise<AllTimeMetrics | null> {
  try {
    const rows = await raw<{ metric: string; total: number; through_date: string | null }>(
      "nb_v_report_metrics_alltime?select=metric,total,through_date",
    );
    const byMetric = Object.fromEntries(rows.map((r) => [r.metric, Number(r.total)]));
    const throughDate = rows.reduce<string | null>(
      (max, r) => (r.through_date && (!max || r.through_date > max) ? r.through_date : max),
      null,
    );
    return {
      visits: byMetric.visits ?? 0,
      touchpoints: byMetric.touchpoints ?? 0,
      miles: byMetric.miles ?? 0,
      daysWorked: byMetric.day_worked ?? 0,
      newAccounts: byMetric.new_accounts ?? 0,
      accountsClosed: byMetric.accounts_closed ?? 0,
      throughDate,
    };
  } catch {
    return null;
  }
}

/** Today in Los Angeles, the day a report is about. Never the server's date:
 *  Vercel runs UTC, and after 17:00 LA those disagree. */
export function reportDateLA(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** The Monday-Sunday week a date falls in. Plain calendar math on a
 *  YYYY-MM-DD string, no timezone in play. Every date has one. */
export function weekWindowFor(dateISO: string): { start: string; end: string } {
  const d = new Date(`${dateISO}T00:00:00`);
  const jsDay = d.getDay();
  const day = jsDay === 0 ? 6 : jsDay - 1;
  const monday = new Date(d);
  monday.setDate(d.getDate() - day);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const fmt = (x: Date) => x.toISOString().slice(0, 10);
  return { start: fmt(monday), end: fmt(sunday) };
}

/** One HQ note on the report: free text the model drafted, human-editable,
 *  with no upstream record for it to contradict. */
export type ReportHqNote = { category: string; text: string; source: string };

export type ReportStop = {
  n?: number;
  name?: string;
  city?: string | null;
  lat?: number | null;
  lng?: number | null;
  is_call_only?: boolean;
  is_message_only?: boolean;
  hidden?: boolean;
  hubspot_id?: string;
  /** field_report.py's own event list for this stop (HubSpot engagement
   *  bodies). Read here only to derive a one-line gist; never edited. */
  events?: Array<{ body?: string | null }>;
};

/** Only the slice of build_report()'s dict this screen reads or writes.
 *  Everything else in the stored payload passes through untouched on a save
 *  (see actionSaveReportEdits below), because it belongs to HubSpot. */
export type ReportPayload = {
  date_label?: string;
  date_iso?: string;
  miles?: number | null;
  miles_override?: number | null;
  hq_notes?: ReportHqNote[];
  summary?: { calls?: number; visits?: number; emails?: number; field_notes?: number };
  stops?: ReportStop[];
  follow_ups?: Array<{ hubspot_id?: string; name?: string; city?: string | null; due?: string | null; body?: string | null }>;
  new_companies?: Array<{ name?: string; properties?: { name?: string } }>;
  closed?: Array<{ id?: string; name?: string; city?: string | null; state?: string | null }>;
  /** Weekly draft only: weekly_report.py's own rollup, read-only here. */
  totals?: { touchpoints?: number; visits?: number; calls?: number; miles?: number; new_accounts?: number; accounts_closed?: number };
  range_label?: string;
  [k: string]: unknown;
};

export type ReportDraft = {
  report_date: string;
  kind: "daily" | "weekly";
  payload: ReportPayload | null;
  status: "pending" | "published";
  dirty: boolean;
  rebuild_requested: boolean;
  edited: boolean;
  preview_path: string | null;
  sent_at: string | null;
  send_error: string | null;
  updated_at: string;
};

export async function getReportDraft(dateISO: string, kind: "daily" | "weekly" = "daily"): Promise<ReportDraft | null> {
  const rows = await raw<ReportDraft>(
    `nb_report_drafts?select=*&report_date=eq.${encodeURIComponent(dateISO)}&kind=eq.${kind}&limit=1`,
  );
  return rows[0] ?? null;
}

/** Ask the Mac for a fresh build. Creates the row if today has none yet. */
export async function requestReportRebuild(dateISO: string): Promise<void> {
  await mutate("nb_report_drafts", "POST", { report_date: dateISO, kind: "daily", rebuild_requested: true, status: "pending" });
}

/** Re-render the preview PDF from whatever payload is already stored, no
 *  HubSpot pull, no status change. `dirty` is what tells field_report.py's
 *  poller to pick this row up. */
export async function requestPreviewRender(dateISO: string, kind: "daily" | "weekly" = "daily"): Promise<void> {
  await mutate(
    "nb_report_drafts",
    "PATCH",
    { dirty: true, updated_at: new Date().toISOString() },
    { report_date: `eq.${dateISO}`, kind: `eq.${kind}` },
  );
}

export type ReportEdits = {
  hqNotes: ReportHqNote[];
  miles: number | null;
  stops: Record<string, { hidden: boolean; call_only: boolean; message_only: boolean }>;
  order?: number[];
};

/**
 * Merge his edits into the stored payload and mark the preview stale.
 * Read-modify-write, deliberately: most of the payload is HubSpot's, so the
 * server re-reads the row and changes only the named fields.
 *
 * SCOPED DOWN FROM THE SOURCE APP. The source's report-actions.ts also lets
 * Juan override the day's route start/end (owned by Route Planner's
 * RouteEndpointField) and reclassify a stop as a field note (a HubSpot
 * engagement-archive write owned by Visit Logger's hubspot client). Neither
 * is ported yet on this feature's own files; both stay on the old app until
 * those features land here, rather than this port depending on their files.
 */
export async function saveReportDraftPayload(dateISO: string, edits: ReportEdits): Promise<void> {
  const draft = await getReportDraft(dateISO, "daily");
  if (!draft?.payload) throw new Error("No report to save edits to.");

  const payload: ReportPayload = { ...draft.payload };
  payload.hq_notes = edits.hqNotes
    .map((n) => ({ category: String(n.category ?? "OTHER"), text: String(n.text ?? "").trim(), source: String(n.source ?? "Juan") }))
    .filter((n) => n.text.length > 0);
  payload.miles_override = edits.miles === null || Number.isNaN(edits.miles) ? null : edits.miles;
  payload.stops = (draft.payload.stops ?? []).map((s) => {
    const e = edits.stops[String(s.n)];
    if (!e) return s;
    return { ...s, hidden: e.hidden, is_call_only: e.call_only, is_message_only: e.message_only };
  });
  if (edits.order && edits.order.length > 0) {
    const byN = new Map((payload.stops ?? []).map((s) => [s.n, s]));
    const ordered = edits.order.map((n) => byN.get(n)).filter((s): s is ReportStop => Boolean(s));
    const placed = new Set(ordered.map((s) => s.n));
    const rest = (payload.stops ?? []).filter((s) => !placed.has(s.n));
    payload.stops = [...ordered, ...rest];
  }

  await mutate(
    "nb_report_drafts",
    "PATCH",
    { payload, dirty: true, edited: true, updated_at: new Date().toISOString() },
    { report_date: `eq.${dateISO}`, kind: "eq.daily" },
  );
}

/** A short-lived signed link to one report object in Storage. Minted at the
 *  moment it is needed and redirected to immediately (see api/reports/pdf),
 *  never stored on a page: a signature starts ageing the instant it is
 *  minted, not the instant it is clicked. */
export async function signReportObject(name: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`${SB_URL}/storage/v1/object/sign/${REPORTS_BUCKET}/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 900 }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const { signedURL } = (await res.json()) as { signedURL: string };
    return `${SB_URL}/storage/v1${signedURL}`;
  } catch {
    return null;
  }
}

export function reportHref(name: string): string {
  return `/api/reports/pdf?name=${encodeURIComponent(name)}`;
}

/** Whether an object exists in the bucket, without minting a signature just
 *  to find out. Returns the stable href, not the signed URL. */
export async function reportPreviewHref(name: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(`${SB_URL}/storage/v1/object/info/${REPORTS_BUCKET}/${encodeURIComponent(name)}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return reportHref(name);
  } catch {
    return null;
  }
}

export type PlaybookReport = { kind: "daily" | "weekly"; label: string; url: string };

function reportLabel(kind: "daily" | "weekly", name: string): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const dayName = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const stem = name.replace(/^(daily|weekly)-/, "").replace(/\.pdf$/, "");
  if (kind === "daily") return `${dayName(stem)}. ${fmt(stem)}`;
  const [start, end] = stem.split("_to_");
  if (!start || !end) return stem;
  return `${fmt(start)} to ${fmt(end)}`;
}

async function listReportObjectsByKind(): Promise<Record<"daily" | "weekly", string[]>> {
  if (!configured()) return { daily: [], weekly: [] };
  const res = await fetchWithTimeout(`${SB_URL}/storage/v1/object/list/${REPORTS_BUCKET}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix: "", limit: 100, sortBy: { column: "name", order: "desc" } }),
    cache: "no-store",
  });
  if (!res.ok) return { daily: [], weekly: [] };
  const objects = (await res.json()) as Array<{ name: string }>;
  return {
    daily: objects.filter((o) => o.name.startsWith("daily-")).map((o) => o.name),
    weekly: objects.filter((o) => o.name.startsWith("weekly-")).map((o) => o.name),
  };
}

function signReportNames(names: string[]): PlaybookReport[] {
  return names.map((name) => {
    const kind = name.startsWith("daily-") ? ("daily" as const) : ("weekly" as const);
    return { kind, label: reportLabel(kind, name), url: reportHref(name) };
  });
}

/** Latest report of each kind. Never throws: an unreachable or empty bucket
 *  just means this section shows nothing. */
export async function listPlaybookReports(): Promise<PlaybookReport[]> {
  try {
    const byKind = await listReportObjectsByKind();
    const latestNames = (["daily", "weekly"] as const).map((kind) => byKind[kind][0]).filter((n): n is string => Boolean(n));
    return signReportNames(latestNames);
  } catch {
    return [];
  }
}

const ARCHIVE_CAP_PER_KIND = 20;

export type PlaybookReportArchive = { reports: PlaybookReport[]; truncated: Partial<Record<"daily" | "weekly", number>> };

export async function listPlaybookReportArchive(): Promise<PlaybookReportArchive> {
  try {
    const byKind = await listReportObjectsByKind();
    const truncated: PlaybookReportArchive["truncated"] = {};
    const names: string[] = [];
    for (const kind of ["daily", "weekly"] as const) {
      const older = byKind[kind].slice(1);
      names.push(...older.slice(0, ARCHIVE_CAP_PER_KIND));
      if (older.length > ARCHIVE_CAP_PER_KIND) truncated[kind] = older.length - ARCHIVE_CAP_PER_KIND;
    }
    return { reports: signReportNames(names), truncated };
  } catch {
    return { reports: [], truncated: {} };
  }
}
