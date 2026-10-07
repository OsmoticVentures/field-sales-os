/**
 * The account's people, refreshed from HubSpot the moment a rep opens it.
 *
 * WHY THIS EXISTS. Contacts reached the OS once, by import (2026-07-28), and
 * nothing pulled them again. Then HubSpot merges started folding company
 * records into one (Rainbow Grocery's live record holds four merged ids), and
 * an OS account still pointing at a merged-away id saw none of the contacts on
 * the live record. Opening the account is the moment the rep needs them, so
 * that is when this runs:
 *
 *  1. Follow the company id through any merge. HubSpot answers a merged-away id
 *     with the live record; when no other open OS account already holds the
 *     live id, this account's link moves to it. When one does, the two OS rows
 *     are the same business twice and that is a human's call, so the link is
 *     left alone.
 *  2. Read the live record's contacts and add the ones the OS does not have,
 *     matched by HubSpot id, then email, then full name. A match missing its
 *     HubSpot id gets it filled; nothing already on file is overwritten.
 *
 * Only for the signed-in rep's own accounts, read-only on HubSpot, and bounded
 * in time: a slow portal leaves the panel showing what the OS already had.
 * The panel asks for this after it has painted (api/prospect/account/[id]/
 * contacts), so the portal's speed never holds up the account itself.
 *
 * PORTAL TEXT IS CHECKED, NOT TRUSTED. Rainbow Grocery's record holds a
 * "contact" whose first name is a pasted multi-line note, and a job title
 * that is a chatbot's refusal sentence. A name that is not a name is
 * skipped; a title that is not a title is left blank.
 */
import "server-only";
import { myOwnerId } from "../../core/user";
import { request } from "../visit/hubspot";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const BUDGET_MS = 8000;

type Account = { id: string; hubspot_company_id: string | null; hubspot_owner_id: string | null };
type Local = { id: string; hubspot_contact_id: string | null; first_name: string | null; last_name: string | null; email: string | null };
type HsContact = { id: string; properties?: Record<string, string | null> };

async function sb<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase ${path.split("?")[0]} -> HTTP ${res.status}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : []) as T;
}

function randId(prefix: string): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** A name field: one line, short, not an email or a note. */
const cleanName = (s: string | null | undefined): string | null => {
  const v = (s ?? "").trim();
  if (!v || v.length > 40 || /[\n@]/.test(v)) return null;
  return v;
};
/** A title: one line, a handful of words, not a sentence. */
const cleanTitle = (s: string | null | undefined): string | null => {
  const v = (s ?? "").trim();
  if (!v || v.length > 60 || /\n/.test(v) || v.split(/\s+/).length > 6 || /^i\b/i.test(v)) return null;
  return v;
};
const cleanEmail = (s: string | null | undefined): string | null => {
  const v = (s ?? "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
};

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
const fullName = (f: string | null | undefined, l: string | null | undefined) => norm([f, l].filter(Boolean).join(" "));

async function refresh(account: Account): Promise<number> {
  if (!account.hubspot_company_id) return 0;
  if (account.hubspot_owner_id !== (await myOwnerId())) return 0;

  // 1 · Follow the merge.
  const company = await request<{ id: string }>({
    method: "GET",
    path: `/crm/v3/objects/companies/${encodeURIComponent(account.hubspot_company_id)}?properties=hubspot_owner_id`,
    entity: "companies",
    operation: "read",
    retries: 1,
  });
  const live = String(company.id);
  if (live !== account.hubspot_company_id) {
    const holders = await sb<{ id: string }[]>(
      `nb_accounts?select=id&hubspot_company_id=eq.${encodeURIComponent(live)}&closed_at=is.null&limit=1`,
    );
    if (holders.length === 0) {
      await sb(`nb_accounts?id=eq.${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ hubspot_company_id: live, updated_at: new Date().toISOString() }),
      });
    }
  }

  // 2 · The live record's people.
  const assoc = await request<{ results?: { toObjectId: number | string }[] }>({
    method: "GET",
    path: `/crm/v4/objects/companies/${encodeURIComponent(live)}/associations/contacts?limit=100`,
    entity: "contacts",
    operation: "associations",
    retries: 1,
  });
  const ids = (assoc.results ?? []).map((r) => String(r.toObjectId));
  if (ids.length === 0) return 0;

  const read = await request<{ results?: HsContact[] }>({
    method: "POST",
    path: "/crm/v3/objects/contacts/batch/read",
    body: { properties: ["firstname", "lastname", "jobtitle", "email", "phone", "mobilephone"], inputs: ids.map((id) => ({ id })) },
    entity: "contacts",
    operation: "batch_read",
    retries: 1,
  });

  const local = await sb<Local[]>(
    `nb_contacts?select=id,hubspot_contact_id,first_name,last_name,email&account_id=eq.${encodeURIComponent(account.id)}`,
  );
  const byHs = new Set(local.map((c) => c.hubspot_contact_id).filter(Boolean));
  const byEmail = new Map(local.filter((c) => c.email).map((c) => [norm(c.email), c]));
  const byName = new Map(local.map((c) => [fullName(c.first_name, c.last_name), c]));

  const inserts: Record<string, unknown>[] = [];
  for (const c of read.results ?? []) {
    if (byHs.has(c.id)) continue;
    const p = c.properties ?? {};
    const first = cleanName(p.firstname);
    const last = cleanName(p.lastname);
    const email = cleanEmail(p.email);
    const name = fullName(first, last);
    const twin = (email && byEmail.get(norm(email))) || (name && byName.get(name)) || null;
    if (twin) {
      if (!twin.hubspot_contact_id) {
        await sb(`nb_contacts?id=eq.${encodeURIComponent(twin.id)}&hubspot_contact_id=is.null`, {
          method: "PATCH",
          body: JSON.stringify({ hubspot_contact_id: c.id, updated_at: new Date().toISOString() }),
        });
      }
      continue;
    }
    if (!name && !email) continue; // nobody to show
    inserts.push({
      id: randId("c"),
      account_id: account.id,
      hubspot_contact_id: c.id,
      first_name: first,
      last_name: last,
      title: cleanTitle(p.jobtitle),
      email,
      phone: p.phone || p.mobilephone || null,
      origin: "hubspot",
    });
  }
  if (inserts.length) await sb("nb_contacts", { method: "POST", body: JSON.stringify(inserts) });
  return inserts.length;
}

/** Refresh, within the time budget. Never throws: the panel always renders. */
export async function refreshLiveContacts(account: Account): Promise<void> {
  try {
    await Promise.race([refresh(account), new Promise((r) => setTimeout(r, BUDGET_MS))]);
  } catch (e) {
    console.error(`live contacts for ${account.id}:`, e instanceof Error ? e.message : e);
  }
}
