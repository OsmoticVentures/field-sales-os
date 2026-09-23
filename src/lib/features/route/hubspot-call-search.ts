/**
 * The call searcher behind AddStop's "who" field: type a name, contact or
 * company, get a phone number without leaving the route to look someone up
 * in HubSpot by hand. Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/hubspot-people-search.ts) with "use
 * server" dropped: called from src/app/api/route/call-search/route.ts over
 * the HubSpot client Visit Logger landed (lib/features/visit/hubspot.ts).
 *
 * PORTAL-WIDE, NOT OWNER-FILTERED. This is a read, not a write: Juan's local
 * nb_ tables only hold his own book, so a search scoped to it would be blind
 * to a contact or company that belongs to another rep or to no one, which
 * is exactly the case where a phone number is worth surfacing before a
 * call. The owner-scope rule governs outward writes; nothing here writes.
 *
 * PHONE, WITH ONE FALLBACK EACH WAY. A contact with no phone of its own
 * falls back to its associated company's; a company with no phone of its
 * own falls back to one of its contacts'. Never a number invented when
 * neither side has one; the call still gets added with an empty phone.
 *
 * ONE WORD GOES OUT, THE FULL QUERY DECIDES THE ORDER. HubSpot's
 * CONTAINS_TOKEN takes one string, so the search goes out on the most
 * selective single word and the results are ranked here against everything
 * typed. Ranked, never filtered.
 */
import "server-only";
import { batchRead, request } from "../visit/hubspot";
import { matchScore, selectiveTokens } from "./search-match";

export type HubspotCallCandidate = {
  id: string;
  kind: "contact" | "company";
  label: string;
  /** Only a company carries one; HubSpot's contact search hands back no address. */
  city: string | null;
  phone: string | null;
  /** Set only when the phone came from the OTHER object, so the UI can say
   *  "via <company>" rather than implying a direct line. */
  phoneVia: string | null;
};

type SearchHit = { id: string; properties?: Record<string, string | null> };

/** HubSpot's phone property is free text. Normalized to E.164 when it is a
 *  clean 10-digit US number; anything odd-shaped passes through rather than
 *  being dropped, since it is still worth having on the call. */
function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let d = trimmed.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length === 10) return `+1${d}`;
  return trimmed;
}

async function searchOnce(term: string): Promise<{ contacts: SearchHit[]; companies: SearchHit[] }> {
  const [contactsRes, companiesRes] = await Promise.all([
    request<{ results?: SearchHit[] }>({
      method: "POST",
      path: "/crm/v3/objects/contacts/search",
      body: {
        limit: 6,
        properties: ["firstname", "lastname", "phone", "associatedcompanyid"],
        // Two filter GROUPS, not two filters in one group: HubSpot ANDs
        // within a group and ORs across groups, and a first name has to
        // match firstname OR lastname, not both at once.
        filterGroups: [
          { filters: [{ propertyName: "firstname", operator: "CONTAINS_TOKEN", value: term }] },
          { filters: [{ propertyName: "lastname", operator: "CONTAINS_TOKEN", value: term }] },
        ],
      },
      entity: "contacts",
      operation: "search",
    }),
    request<{ results?: SearchHit[] }>({
      method: "POST",
      path: "/crm/v3/objects/companies/search",
      body: {
        limit: 6,
        properties: ["name", "phone", "city"],
        filterGroups: [{ filters: [{ propertyName: "name", operator: "CONTAINS_TOKEN", value: term }] }],
      },
      entity: "companies",
      operation: "search",
    }),
  ]);
  return { contacts: contactsRes.results ?? [], companies: companiesRes.results ?? [] };
}

export async function searchHubspotForCall(query: string): Promise<HubspotCallCandidate[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  let contacts: SearchHit[] = [];
  let companies: SearchHit[] = [];
  try {
    const terms = selectiveTokens(q, 2);
    for (const term of terms.length > 0 ? terms : [q]) {
      const hit = await searchOnce(term);
      if (hit.contacts.length > 0 || hit.companies.length > 0) {
        contacts = hit.contacts;
        companies = hit.companies;
        break;
      }
    }
  } catch {
    // HubSpot unreachable or unconfigured: the field still works, it just
    // has nothing to suggest.
    return [];
  }

  // Contact -> company phone fallback: associatedcompanyid comes back for
  // free on the search above, so this is one batch read, not one per contact.
  const companyIdsNeeded = Array.from(
    new Set(
      contacts
        .filter((c) => !c.properties?.phone && c.properties?.associatedcompanyid)
        .map((c) => c.properties!.associatedcompanyid as string),
    ),
  );
  const companyPhoneById = new Map<string, string | null>();
  const companyNameById = new Map<string, string | null>();
  if (companyIdsNeeded.length > 0) {
    try {
      const rows = await batchRead("companies", companyIdsNeeded, ["phone", "name"]);
      for (const r of rows) {
        companyPhoneById.set(r.id, r.properties?.phone ?? null);
        companyNameById.set(r.id, r.properties?.name ?? null);
      }
    } catch {
      // The contact still appears, just without a company-sourced phone.
    }
  }

  const contactResults: HubspotCallCandidate[] = contacts.map((c) => {
    const first = c.properties?.firstname ?? "";
    const last = c.properties?.lastname ?? "";
    const name = [first, last].filter(Boolean).join(" ").trim() || "(no name)";
    const ownPhone = toE164(c.properties?.phone);
    const companyId = c.properties?.associatedcompanyid ?? null;
    const fallbackRaw = ownPhone || !companyId ? null : (companyPhoneById.get(companyId) ?? null);
    return {
      id: c.id,
      kind: "contact",
      label: name,
      city: null,
      phone: ownPhone ?? toE164(fallbackRaw),
      phoneVia: ownPhone ? null : fallbackRaw ? (companyNameById.get(companyId!) ?? "their company") : null,
    };
  });

  // Company -> a contact's phone fallback: one associations call per company
  // that needs it (only those with no phone of their own, at most 6).
  const companiesNeedingContactPhone = companies.filter((co) => !co.properties?.phone);
  const contactFallbackByCompany = new Map<string, { phone: string; name: string } | null>();
  if (companiesNeedingContactPhone.length > 0) {
    await Promise.all(
      companiesNeedingContactPhone.map(async (co) => {
        try {
          const assoc = await request<{ results?: Array<{ toObjectId?: number; id?: string }> }>({
            method: "GET",
            path: `/crm/v4/objects/companies/${co.id}/associations/contacts`,
            entity: "companies",
            operation: "read",
          });
          const contactIds = (assoc.results ?? [])
            .map((r) => (r.toObjectId !== undefined ? String(r.toObjectId) : r.id))
            .filter((x): x is string => Boolean(x))
            .slice(0, 5);
          if (contactIds.length === 0) return;
          const rows = await batchRead("contacts", contactIds, ["phone", "firstname", "lastname"]);
          const withPhone = rows.find((r) => r.properties?.phone);
          if (!withPhone?.properties?.phone) return;
          const name = [withPhone.properties.firstname, withPhone.properties.lastname].filter(Boolean).join(" ").trim();
          contactFallbackByCompany.set(co.id, { phone: withPhone.properties.phone, name: name || "a contact" });
        } catch {
          // One company's association lookup failing does not sink the rest.
        }
      }),
    );
  }

  const companyResults: HubspotCallCandidate[] = companies.map((co) => {
    const ownPhone = toE164(co.properties?.phone);
    const fallback = ownPhone ? null : (contactFallbackByCompany.get(co.id) ?? null);
    return {
      id: co.id,
      kind: "company",
      label: co.properties?.name ?? "(no name)",
      city: co.properties?.city ?? null,
      phone: ownPhone ?? toE164(fallback?.phone ?? null),
      phoneVia: ownPhone ? null : fallback ? fallback.name : null,
    };
  });

  return [...contactResults, ...companyResults]
    .map((c) => ({ c, score: matchScore(q, { name: c.label, also: [c.city] }) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => a.score - b.score)
    .map(({ c }) => c);
}
