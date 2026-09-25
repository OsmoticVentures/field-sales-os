/**
 * Data access for Visit Logger, direct to Supabase REST, same pattern as
 * lib/core/devices.ts: there is no shared data layer in this repo yet (m5's
 * port of the old app's lib/dal.ts, 5,243 lines, has not happened), so this
 * is a feature-local slice, named for what it does, per PORTING.md. Only
 * Visit Logger's own tables and only the functions this feature actually
 * calls; nothing here is a general-purpose ORM.
 *
 * SCOPE NOTE (read before extending). The source app's lib/dal.ts carries a
 * PostgREST 1000-row pager, an 8s fetch timeout with one retry, and a
 * near-duplicate-visit guard on insertActivity (resaySimilarity). None of
 * that is reproduced here: every read in this feature is already narrow
 * (a handful of pending rows, one account's contacts), so the pager is dead
 * weight, and the duplicate-visit guard needs a second read plus a text
 * similarity function this port did not bring over. Both are real
 * improvements a later pass should port in, not decisions this file makes
 * on purpose.
 */
import "server-only";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

export const isConfigured = (): boolean => Boolean(SB_URL && SB_KEY);

/** Juan's HubSpot owner id. Hardcoded, mirrors lib/hubspot.ts's OWNER_ID and
 *  the source dal.ts's JUAN_OWNER_ID: the scope guard must never widen by a
 *  config edit. */
export const JUAN_OWNER_ID = "36242368";

function randId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

type QueryOpts = Record<string, string | number | undefined>;

async function query<T>(table: string, opts: QueryOpts): Promise<T[]> {
  if (!isConfigured()) return [];
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) {
    if (v !== undefined) params.set(k, String(v));
  }
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase ${table} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T[];
}

async function mutate<T>(
  table: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
  filter?: QueryOpts,
): Promise<T[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter ?? {})) {
    if (v !== undefined) params.set(k, String(v));
  }
  const res = await fetch(`${SB_URL}/rest/v1/${table}${filter ? `?${params}` : ""}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(method === "POST" ? body : body),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Supabase ${table} ${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const text = await res.text();
  return text ? (JSON.parse(text) as T[]) : [];
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

export type AccountCandidate = { id: string; name: string; city: string | null };

/** Every account in Juan's book a touchpoint could legitimately land on:
 *  owned, not closed, not a waypoint. Mirrors the source's
 *  listAccountsForMatching(), queried directly against nb_accounts rather
 *  than the nb_v_account_tier view, since only id/name/city are needed here. */
export async function listAccountsForMatching(): Promise<AccountCandidate[]> {
  return query<AccountCandidate>("nb_accounts", {
    select: "id,name,city",
    hubspot_owner_id: `eq.${JUAN_OWNER_ID}`,
    closed_at: "is.null",
    lifecycle: "neq.waypoint",
  });
}

/** Manual match search (AccountMatchResolver's "New client" box, simplified
 *  to search Juan's own book rather than Google Places, see the port's
 *  handback note): name contains the query, case-insensitive. */
export async function searchAccounts(q: string): Promise<AccountCandidate[]> {
  const term = q.trim();
  if (!term) return [];
  return query<AccountCandidate>("nb_accounts", {
    select: "id,name,city",
    hubspot_owner_id: `eq.${JUAN_OWNER_ID}`,
    closed_at: "is.null",
    name: `ilike.*${term}*`,
    limit: "8",
  });
}

export type Account = {
  id: string;
  name: string;
  city: string | null;
  phone: string | null;
  email: string | null;
  business_hours: Record<string, string[][]> | null;
  enrichment_status: Record<string, { source_tier?: string }> | null;
  hubspot_company_id: string | null;
  owner_name: string | null;
};

export async function getAccount(id: string): Promise<Account | null> {
  const rows = await query<Account>("nb_accounts", {
    select: "id,name,city,phone,email,business_hours,enrichment_status,hubspot_company_id,owner_name",
    id: `eq.${id}`,
    limit: "1",
  });
  return rows[0] ?? null;
}

export type EngagementAccount = {
  id: string;
  name: string;
  hubspot_company_id: string | null;
  owner_name: string | null;
};

export async function getAccountForEngagement(id: string): Promise<EngagementAccount | null> {
  const rows = await query<EngagementAccount>("nb_accounts", {
    select: "id,name,hubspot_company_id,owner_name",
    id: `eq.${id}`,
    limit: "1",
  });
  return rows[0] ?? null;
}

export type AccountFactsReport = {
  business_hours: { status: "filled" | "updated"; old?: Record<string, string[][]> | null } | null;
  phone: { status: "filled" | "updated"; old?: string | null; value: string } | null;
  email: { status: "filled" | "updated"; old?: string | null; value: string } | null;
};

/** Blank-fills nb_accounts from facts stated during the visit. Mirrors the
 *  source's applyAccountFacts, minus the HubSpot company push (that push
 *  lives in the source's hubspot-company.ts, not ported here, see the
 *  port's handback: writes land in the OS either way, which is the
 *  authoritative record). */
export async function applyAccountFacts(
  accountId: string,
  facts: { business_hours: Record<string, string[][]> | null; phone: string | null; email: string | null },
): Promise<AccountFactsReport> {
  const report: AccountFactsReport = { business_hours: null, phone: null, email: null };
  const hasAnyHours = facts.business_hours && Object.values(facts.business_hours).some((w) => w.length > 0);
  if (!hasAnyHours && !facts.phone && !facts.email) return report;

  const row = await getAccount(accountId);
  if (!row) return report;

  const patch: Record<string, unknown> = {};
  const status = { ...(row.enrichment_status || {}) };
  const stamp = { source_tier: "manual_note", found_by: "visit logger note", at: new Date().toISOString() };

  if (hasAnyHours) {
    if (!row.business_hours) {
      patch.business_hours = facts.business_hours;
      report.business_hours = { status: "filled" };
      status.business_hours = stamp;
    } else if (JSON.stringify(row.business_hours) !== JSON.stringify(facts.business_hours)) {
      patch.business_hours = facts.business_hours;
      report.business_hours = { status: "updated", old: row.business_hours };
      status.business_hours = stamp;
    }
  }
  if (facts.phone) {
    if (!row.phone) {
      patch.phone = facts.phone;
      report.phone = { status: "filled", value: facts.phone };
      status.phone = stamp;
    } else if (row.phone !== facts.phone) {
      patch.phone = facts.phone;
      report.phone = { status: "updated", old: row.phone, value: facts.phone };
      status.phone = stamp;
    }
  }
  if (facts.email) {
    if (!row.email) {
      patch.email = facts.email;
      report.email = { status: "filled", value: facts.email };
    } else if (row.email !== facts.email) {
      patch.email = facts.email;
      report.email = { status: "updated", old: row.email, value: facts.email };
    }
  }

  if (Object.keys(patch).length > 0) {
    if (patch.business_hours !== undefined || patch.phone !== undefined) patch.enrichment_status = status;
    await mutate("nb_accounts", "PATCH", patch, { id: `eq.${accountId}` });
  }
  return report;
}

/** Bare-minimum "this is a new business" insert: no HubSpot company id yet
 *  (a human links one, or a future graduation path does). This substitutes
 *  for the source's Google-Places-driven createBusinessFromPlace, which
 *  this port does not carry (see handback). */
export async function insertBareAccount(input: { name: string; city?: string | null }): Promise<Account> {
  const [row] = await mutate<Account>("nb_accounts", "POST", {
    id: randId("a"),
    name: input.name,
    city: input.city ?? null,
    origin: "manual",
    hubspot_owner_id: JUAN_OWNER_ID,
    owner_name: "Juan Arenas Martin",
  });
  return row;
}

// ---------------------------------------------------------------------------
// contacts
// ---------------------------------------------------------------------------

export type Contact = {
  id: string;
  account_id: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  role_tag: string | null;
  is_decision_maker: boolean;
  email: string | null;
  phone: string | null;
  hubspot_contact_id: string | null;
};

export async function listContacts(accountId: string): Promise<Contact[]> {
  return query<Contact>("nb_contacts", {
    select: "*",
    account_id: `eq.${accountId}`,
    order: "is_decision_maker.desc,last_name.asc",
  });
}

export type NewContact = {
  account_id: string;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  role_tag?: string | null;
  is_decision_maker?: boolean;
  email?: string | null;
  phone?: string | null;
};

/** Mirrors the source insertContact: a same-account same-email conflict is
 *  a shared inbox, not a bug, and is treated as a no-op rather than an
 *  error (Juan, 2026-09-16). */
export async function insertContact(input: NewContact): Promise<Contact> {
  try {
    const [row] = await mutate<Contact>("nb_contacts", "POST", { id: randId("c"), origin: "manual", ...input });
    return row;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (input.email && msg.includes('"code":"23505"')) {
      const existing = await query<Contact>("nb_contacts", { select: "*", account_id: `eq.${input.account_id}` });
      const email = input.email.trim().toLowerCase();
      const hit = existing.find((c) => (c.email ?? "").trim().toLowerCase() === email);
      if (hit) return hit;
    }
    throw e;
  }
}

/** Fills blanks only, never overwrites a field the CRM already has. */
export async function patchContact(id: string, patch: Partial<NewContact>): Promise<Contact> {
  const [row] = await mutate<Contact>("nb_contacts", "PATCH", patch, { id: `eq.${id}` });
  return row;
}

export async function linkContactHubspotId(id: string, hubspotContactId: string): Promise<void> {
  await mutate("nb_contacts", "PATCH", { hubspot_contact_id: hubspotContactId }, { id: `eq.${id}`, hubspot_contact_id: "is.null" });
}

// ---------------------------------------------------------------------------
// activities
// ---------------------------------------------------------------------------

export type NewActivity = {
  account_id: string;
  kind: string;
  direction: string;
  outcome: string | null;
  detail: string;
  at?: string;
};

export type Activity = { id: number; account_id: string; kind: string };

export async function insertActivity(input: NewActivity): Promise<Activity> {
  const [row] = await mutate<Activity>("nb_activities", "POST", { ...input, actor: "juan", origin: "manual" });
  return row;
}

export type EngagementActivity = {
  id: number;
  account_id: string;
  contact_id: string | null;
  at: string | null;
  logged_at: string | null;
  kind: string;
  direction: string;
  outcome: string | null;
  detail: string | null;
  hubspot_engagement_id: string | null;
  origin: string;
};

export async function getActivityById(id: number): Promise<EngagementActivity | null> {
  const rows = await query<EngagementActivity>("nb_activities", {
    select: "id,account_id,contact_id,at,logged_at,kind,direction,outcome,detail,hubspot_engagement_id,origin",
    id: `eq.${id}`,
    limit: "1",
  });
  return rows[0] ?? null;
}

/** Another activity on the same account, already filed, carrying the exact
 *  same detail text within a short window. Mirrors the source's
 *  findRecentDuplicateEngagement. */
export async function findRecentDuplicateEngagement(
  accountId: string,
  detail: string,
  excludeActivityId: number,
  windowMinutes = 30,
): Promise<{ id: number; hubspot_engagement_id: string } | null> {
  const rows = await query<{ id: number; hubspot_engagement_id: string | null; at: string | null }>("nb_activities", {
    select: "id,hubspot_engagement_id,at",
    account_id: `eq.${accountId}`,
    detail: `eq.${detail}`,
    id: `neq.${excludeActivityId}`,
    hubspot_engagement_id: "not.is.null",
    order: "at.desc",
    limit: "5",
  });
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  for (const row of rows) {
    if (!row.hubspot_engagement_id) continue;
    const at = row.at ? new Date(row.at).getTime() : 0;
    if (at >= cutoff) return { id: row.id, hubspot_engagement_id: row.hubspot_engagement_id };
  }
  return null;
}

export async function stampActivityEngagementId(activityId: number, engagementId: string): Promise<void> {
  await mutate("nb_activities", "PATCH", { hubspot_engagement_id: engagementId }, { id: `eq.${activityId}`, hubspot_engagement_id: "is.null" });
}

// ---------------------------------------------------------------------------
// touchpoints and field notes
// ---------------------------------------------------------------------------

export type Touchpoint = {
  id: string;
  account_id: string | null;
  raw_text: string;
  status: string;
  account_match_confidence: string | null;
  activity_id: number | null;
  parsed: unknown;
  created_at: string;
};

export async function insertTouchpoint(input: {
  account_id: string | null;
  raw_text: string;
  status: string;
  account_match_confidence?: string | null;
  activity_id?: number | null;
  parsed?: unknown;
}): Promise<Touchpoint> {
  const [row] = await mutate<Touchpoint>("nb_touchpoints", "POST", { id: randId("t"), origin: "manual", ...input });
  return row;
}

export async function getTouchpointById(id: string): Promise<Touchpoint | null> {
  const rows = await query<Touchpoint>("nb_touchpoints", { select: "*", id: `eq.${id}`, limit: "1" });
  return rows[0] ?? null;
}

export async function finalizeTouchpointAccount(id: string, accountId: string, activityId: number): Promise<Touchpoint | null> {
  const rows = await mutate<Touchpoint>(
    "nb_touchpoints",
    "PATCH",
    { account_id: accountId, status: "parsed", activity_id: activityId },
    { id: `eq.${id}`, status: "eq.needs_account" },
  );
  return rows[0] ?? null;
}

export async function finalizeTouchpointNextStep(id: string, activityId: number, parsed: unknown): Promise<Touchpoint | null> {
  const rows = await mutate<Touchpoint>(
    "nb_touchpoints",
    "PATCH",
    { status: "parsed", activity_id: activityId, parsed },
    { id: `eq.${id}`, status: "eq.needs_next_step" },
  );
  return rows[0] ?? null;
}

export async function listPendingAccountMatches(limit = 10): Promise<Touchpoint[]> {
  return query<Touchpoint>("nb_touchpoints", {
    select: "id,account_id,raw_text,status,account_match_confidence,activity_id,parsed,created_at",
    status: "eq.needs_account",
    order: "created_at.asc",
    limit: String(limit),
  });
}

export async function listPendingNextSteps(limit = 10): Promise<Touchpoint[]> {
  return query<Touchpoint>("nb_touchpoints", {
    select: "id,account_id,raw_text,status,account_match_confidence,activity_id,parsed,created_at",
    status: "eq.needs_next_step",
    order: "created_at.asc",
    limit: String(limit),
  });
}

export async function getAccountNames(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  const rows = await query<{ id: string; name: string }>("nb_accounts", {
    select: "id,name",
    id: `in.(${ids.join(",")})`,
  });
  return Object.fromEntries(rows.map((a) => [a.id, a.name]));
}

export async function insertFieldNote(input: {
  account_id: string | null;
  touchpoint_id: string | null;
  detail: string;
  raw_text: string | null;
}): Promise<{ id: string }> {
  const [row] = await mutate<{ id: string }>("nb_field_notes", "POST", {
    id: randId("fn"),
    origin: "manual",
    topic: input.account_id ? "account" : "field",
    ...input,
  });
  return row;
}

/**
 * A "come back" stated in a logged note, queued pending for
 * nutribiotic-route-planner in nb_directives, same row shape the source's
 * insertDirectives writes. Route's Suggested returns reads these back
 * (lib/features/route/dal.ts's listPendingReturnDirectives).
 */
export async function insertReturnDirectives(
  rows: { field_note_id: string | null; directive: string; account_id: string | null }[],
): Promise<number> {
  for (const r of rows) {
    await mutate("nb_directives", "POST", {
      id: randId("dir"),
      status: "pending",
      target: "nutribiotic-route-planner",
      scope: "nutribiotic",
      ...r,
    });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// HubSpot call log (best-effort, mirrors the source's logHubspotCall)
// ---------------------------------------------------------------------------

export type HubspotLogRow = {
  direction: "pull" | "push";
  entity: string;
  operation: string;
  payload_hash: string;
  status: string;
  http_status?: number;
  request?: unknown;
  response?: unknown;
  error?: string;
};

export async function logHubspotCall(row: HubspotLogRow): Promise<void> {
  if (!isConfigured()) return;
  try {
    await fetch(`${SB_URL}/rest/v1/nb_hubspot_sync_log`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify([row]),
      cache: "no-store",
    });
  } catch {
    // The log is best-effort; it must never fail the write it is logging.
  }
}

// ---------------------------------------------------------------------------
// door reads: Potential, Readiness, photo
// ---------------------------------------------------------------------------

export const VISIT_GRADES = ["A", "B", "C", "D", "E"] as const;
export type VisitGrade = (typeof VISIT_GRADES)[number];
export const READINESS_VALUES = ["urgent", "hot", "normal", "cold"] as const;
export type Readiness = (typeof READINESS_VALUES)[number];

export async function setAccountPotentialJuan(accountId: string, grade: VisitGrade | null): Promise<void> {
  await mutate("nb_accounts", "PATCH", { potential_juan: grade }, { id: `eq.${accountId}` });
}

export async function setAccountReadiness(accountId: string, readiness: Readiness | null): Promise<void> {
  await mutate(
    "nb_accounts",
    "PATCH",
    { readiness, readiness_set_at: readiness ? new Date().toISOString() : null },
    { id: `eq.${accountId}` },
  );
}

export type TouchpointAttachment = { name: string; url: string; uploaded_at: string };

/** Uploads to Drive (same folder tree as the source app), then appends the
 *  link onto the touchpoint's attachments. */
export async function attachTouchpointPhoto(
  touchpointId: string,
  photo: { bytes: ArrayBuffer; mimeType: string; filename: string },
): Promise<{ attachments: TouchpointAttachment[] }> {
  if (!isConfigured()) throw new Error("Cannot attach a photo: no data source configured.");
  const { ensureFolder, uploadFile, asOwnerLink } = await import("../../shared/gdrive");
  const root = await ensureFolder("NutriBiotic Field Notes", null);
  const day = await ensureFolder(new Date().toISOString().slice(0, 10), root.id);
  const ext = photo.filename.includes(".") ? photo.filename.slice(photo.filename.lastIndexOf(".")) : ".jpg";
  const name = `${touchpointId}_${Date.now().toString(36)}${ext}`;
  const uploaded = await uploadFile(photo.bytes, photo.mimeType, day.id, name);

  const rows = await query<{ attachments: TouchpointAttachment[] | null }>("nb_touchpoints", {
    select: "attachments",
    id: `eq.${touchpointId}`,
    limit: "1",
  });
  const attachments: TouchpointAttachment[] = [
    ...(rows[0]?.attachments ?? []),
    { name, url: asOwnerLink(uploaded.webViewLink), uploaded_at: new Date().toISOString() },
  ];
  const [row] = await mutate<{ attachments: TouchpointAttachment[] }>(
    "nb_touchpoints",
    "PATCH",
    { attachments },
    { id: `eq.${touchpointId}` },
  );
  return row;
}
