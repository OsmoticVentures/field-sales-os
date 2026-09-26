/**
 * Find Contacts' own data access. Reads reuse prospect/dal.ts (getAccount,
 * listContacts) per this milestone's instruction rather than a second copy
 * of the same query; writes are new here because prospect/dal.ts exports no
 * generic account patch or contact insert, and this feature's write rules
 * (blank-fill, provenance on every field, re-read the live row first) are
 * its own, not prospect's.
 *
 * NEVER TOUCHES HUBSPOT (nutribiotic-enricher.md). Every write below is
 * nb_accounts or nb_contacts or nb_activities, nothing else, and every
 * caller is scoped to Juan's own book first (inScope below), the same
 * hubspot_owner_id headhunter.py checks.
 */
import "server-only";
import { getAccount, listContacts, type Account, type Contact } from "../prospect/dal";
import type { Proposal, Provenance } from "./types";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
export const isConfigured = (): boolean => Boolean(SB_URL && SB_KEY);

const JUAN_OWNER_ID = "36242368";

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sbPatch(table: string, body: unknown, id: string): Promise<void> {
  if (!isConfigured()) throw new Error(`Cannot write to "${table}": no data source configured.`);
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${table} PATCH -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function sbInsert<T>(table: string, body: unknown): Promise<T | null> {
  if (!isConfigured()) throw new Error(`Cannot write to "${table}": no data source configured.`);
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${table} POST -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  const rows = text ? (JSON.parse(text) as T[]) : [];
  return rows[0] ?? null;
}

function randId(prefix: string): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export { getAccount, listContacts };
export type { Account, Contact };

/** The wider row shape this pipeline needs, past what prospect/dal.ts's
 *  `Account` type declares. `getAccount` already selects `*`, so the extra
 *  columns are on the row at runtime; this only widens the TS view of it,
 *  never a second fetch. */
export type EnrichAccount = Account & {
  email: string | null;
  instagram_url: string | null;
  facebook_url: string | null;
  linkedin_url: string | null;
  places_id: string | null;
  places_status: string | null;
  places_primary_type: string | null;
  places_rating: number | null;
  places_rating_count: number | null;
  hubspot_owner_id: string | null;
  owner_name: string | null;
  origin: string | null;
  closed_at: string | null;
};

export async function getEnrichAccount(id: string): Promise<EnrichAccount | null> {
  const row = await getAccount(id);
  return row as EnrichAccount | null;
}

/** Same scope assertion as headhunter.py's `in_scope`: this pipeline only
 *  ever runs against an open account in Juan's own book. */
export function outOfScopeReason(acc: EnrichAccount): string | null {
  if (String(acc.hubspot_owner_id || "") !== JUAN_OWNER_ID) return "This account is not in Juan's book.";
  if (acc.origin === "synthetic") return "This is a seed row, not a real account.";
  if (acc.closed_at) return "This account is closed.";
  return null;
}

/** Never overwrite: a blank-fill goes straight through, a disagreement comes
 *  back to the caller as a would-be proposal rather than a write. Re-reads
 *  the live row right before deciding, per the department's standing rule
 *  that a concurrent pass may have filled the cell since the search ran. */
export async function patchAccountBlankFill(
  accountId: string,
  patch: Record<string, unknown>,
  provenance: Record<string, Provenance>,
): Promise<void> {
  const live = await getEnrichAccount(accountId);
  if (!live) return;
  const finalPatch: Record<string, unknown> = {};
  const status: Record<string, unknown> = { ...(live.enrichment_status || {}) };
  for (const [field, value] of Object.entries(patch)) {
    const current = (live as unknown as Record<string, unknown>)[field];
    const blank = current == null || (typeof current === "string" && current.trim() === "");
    if (!blank) continue; // a value already on file is never overwritten
    finalPatch[field] = value;
    if (provenance[field]) status[field] = provenance[field];
  }
  if (Object.keys(finalPatch).length === 0) return;
  finalPatch.enrichment_status = status;
  await sbPatch("nb_accounts", finalPatch, accountId);
}

/** The marker every pass writes regardless of outcome (headhunter.py's
 *  MARKER): a blank is a finding too, and it is what a future pass reads
 *  before spending tiers 3-4 again. */
export async function stampSearchMarker(accountId: string, marker: Record<string, unknown>): Promise<void> {
  const live = await getEnrichAccount(accountId);
  if (!live) return;
  const status = { ...(live.enrichment_status || {}), decision_maker_search: marker };
  await sbPatch("nb_accounts", { enrichment_status: status }, accountId);
}

export type NewFoundContact = {
  account_id: string;
  first_name: string;
  last_name: string | null;
  title: string | null;
  is_decision_maker: boolean;
  enrichment_status: Record<string, Provenance>;
};

export async function insertFoundContact(row: NewFoundContact): Promise<Contact | null> {
  return sbInsert<Contact>("nb_contacts", { id: randId("c"), origin: "enriched", ...row });
}

/** A blank title on an existing contact gets filled; anything else is the
 *  caller's job to turn into a proposal instead of calling this. */
export async function fillContactTitle(contactId: string, title: string, provenance: Provenance): Promise<void> {
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/nb_contacts?id=eq.${encodeURIComponent(contactId)}&select=title,enrichment_status`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: "application/json" },
    cache: "no-store",
  });
  const rows = res.ok ? ((await res.json()) as { title: string | null; enrichment_status: Record<string, unknown> | null }[]) : [];
  const live = rows[0];
  if (!live || (live.title || "").trim()) return; // re-read: someone may have filled it since
  const status = { ...(live.enrichment_status || {}), title: provenance };
  await sbPatch("nb_contacts", { title, enrichment_status: status }, contactId);
}

/**
 * Juan taps Accept on a proposal. The live row is read again right here,
 * never trusted from the run that surfaced the proposal, and the write only
 * happens if the field still holds exactly the `on_file` value the
 * proposal was made against; a field a human or another pass has since
 * changed is left alone and reported back as a conflict, not silently
 * overwritten a second time.
 */
export async function applyProposal(p: Proposal): Promise<{ ok: boolean; error?: string }> {
  const now = new Date().toISOString();
  const provenance: Provenance = { found_by: p.evidence.split(". ")[0] || p.evidence, at: now, basis: p.evidence, source_tier: p.source_tier };

  if (p.kind === "account_field") {
    const live = await getEnrichAccount(p.account_id);
    if (!live) return { ok: false, error: "That account no longer exists." };
    const current = (live as unknown as Record<string, unknown>)[p.field];
    const currentStr = current == null ? null : String(current);
    if (currentStr !== p.on_file) return { ok: false, error: "This field changed since the proposal was made." };
    const status = { ...(live.enrichment_status || {}), [p.field]: provenance };
    await sbPatch("nb_accounts", { [p.field]: p.found, enrichment_status: status }, p.account_id);
    return { ok: true };
  }

  if (!p.contact_id) return { ok: false, error: "No contact named on this proposal." };
  const res = await fetchWithTimeout(
    `${SB_URL}/rest/v1/nb_contacts?id=eq.${encodeURIComponent(p.contact_id)}&select=title,is_decision_maker,enrichment_status`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: "application/json" }, cache: "no-store" },
  );
  const rows = res.ok
    ? ((await res.json()) as { title: string | null; is_decision_maker: boolean; enrichment_status: Record<string, unknown> | null }[])
    : [];
  const live = rows[0];
  if (!live) return { ok: false, error: "That contact no longer exists." };

  if (p.field === "is_decision_maker") {
    if (live.is_decision_maker) return { ok: true }; // already true, nothing to do
    const status = { ...(live.enrichment_status || {}), is_decision_maker: provenance };
    await sbPatch("nb_contacts", { is_decision_maker: true, enrichment_status: status }, p.contact_id);
    return { ok: true };
  }

  if ((live.title || null) !== p.on_file) return { ok: false, error: "This field changed since the proposal was made." };
  const status = { ...(live.enrichment_status || {}), title: provenance };
  await sbPatch("nb_contacts", { title: p.found, enrichment_status: status }, p.contact_id);
  return { ok: true };
}

const DISMISSED_CAP = 200;

/** No write undoes anything here; a dismissal only keeps this exact
 *  proposal from resurfacing the next time Find Contacts runs on this
 *  account, the same way a curated value already on file would. */
export async function dismissProposal(accountId: string, proposalId: string): Promise<void> {
  const live = await getEnrichAccount(accountId);
  if (!live) return;
  const status = { ...(live.enrichment_status || {}) } as Record<string, unknown>;
  const existing = Array.isArray(status.dismissed_proposals) ? (status.dismissed_proposals as string[]) : [];
  if (existing.includes(proposalId)) return;
  status.dismissed_proposals = [...existing, proposalId].slice(-DISMISSED_CAP);
  await sbPatch("nb_accounts", { enrichment_status: status }, accountId);
}

/** Closed is a note, never a routing decision (nutribiotic-enricher.md):
 *  this never touches `do_not_visit`, and `origin: "enriched"` keeps it out
 *  of the call card's own "meetings and calls" list, same filter
 *  prospect/dal.ts's `listActivities` already applies. */
export async function insertClosedSignalNote(accountId: string, detail: string): Promise<void> {
  await sbInsert("nb_activities", {
    account_id: accountId,
    kind: "note",
    direction: "internal",
    outcome: null,
    detail,
    actor: "find_contacts",
    origin: "enriched",
  });
}
