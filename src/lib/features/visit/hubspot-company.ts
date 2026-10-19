/**
 * Creating the one HubSpot company a brand-new OS account has none of yet.
 * Port of portfolio/src/app/nutribiotic/lib/hubspot-company.ts (itself a port
 * of bridges/nutribiotic/hubspot_create_company.py), trimmed to the two calls
 * the Visit new-account path needs.
 *
 * Portal 148711228 is shared with another rep and holds unowned companies. A
 * store already on file there is invisible to nb_accounts, so every create is
 * preceded by a live, portal-wide (not owner-filtered) name + domain search,
 * and any hit blocks the create.
 */
import "server-only";
import { ownerId, request } from "./hubspot";
import { getAccountCompanyFacts, linkAccountCompany } from "./dal";
import { once } from "../../core/once-server";

export type DuplicateCandidate = {
  id: string;
  name: string | null;
  city: string | null;
  owner: string | null;
};

/** A search failure throws: creating blind is the risk this guard exists for. */
export async function findPossibleDuplicates(name: string, website?: string | null): Promise<DuplicateCandidate[]> {
  const seen = new Map<string, DuplicateCandidate>();

  async function run(filters: Array<{ propertyName: string; operator: string; value: string }>) {
    const res = await request<{ results?: Array<{ id: string; properties?: Record<string, string | null> }> }>({
      method: "POST",
      path: "/crm/v3/objects/companies/search",
      body: { limit: 10, properties: ["name", "city", "hubspot_owner_id"], filterGroups: [{ filters }] },
      entity: "companies",
      operation: "search",
    });
    for (const r of res.results ?? []) {
      seen.set(r.id, {
        id: r.id,
        name: r.properties?.name ?? null,
        city: r.properties?.city ?? null,
        owner: r.properties?.hubspot_owner_id ?? null,
      });
    }
  }

  await run([{ propertyName: "name", operator: "CONTAINS_TOKEN", value: name }]);
  if (website) {
    const domain = website.replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "").trim().toLowerCase();
    if (domain) await run([{ propertyName: "domain", operator: "EQ", value: domain }]);
  }
  return Array.from(seen.values());
}

/** Owned to the signed-in rep, lead status NEW (the one documented create-time exception
 *  to hs_lead_status being pull-only). Only non-empty fields are sent. */
export async function createCompany(input: {
  name: string;
  street?: string | null;
  postal?: string | null;
  city?: string | null;
  state?: string | null;
  phone?: string | null;
  website?: string | null;
}): Promise<string> {
  const properties: Record<string, string> = { hubspot_owner_id: await ownerId(), name: input.name, hs_lead_status: "NEW" };
  if (input.street) properties.address = input.street;
  if (input.postal) properties.zip = input.postal;
  if (input.phone) properties.phone = input.phone;
  if (input.website) properties.website = input.website;
  if (input.city) properties.city = input.city;
  if (input.state) properties.state = input.state;

  const res = await request<{ id?: string }>({
    method: "POST",
    path: "/crm/v3/objects/companies",
    body: { properties },
    entity: "companies",
    operation: "create",
    feature: "visit",
  });
  if (!res.id) throw new Error("HubSpot accepted the company but returned no id.");
  return res.id;
}

/** The portal company behind an account a visit is being filed on, created
 *  on the spot when it has none (Juan, 2026-10-19: "when I log a visit it goes
 *  to hubspot always"). A Lead Scout or Places prospect lands with no company
 *  on purpose, and nothing ever gave it one once he walked in, so his Oct 16
 *  re_ grocery visit stayed in the OS and missed his weekly report. The same
 *  portal-wide duplicate check as a new business runs first, and any hit
 *  fails loud with the names rather than creating a second record. */
export async function ensureCompanyFor(accountId: string): Promise<string> {
  const { result } = await once(`hubspot:company:${accountId}`, async () => {
    const a = await getAccountCompanyFacts(accountId);
    if (!a) throw new Error(`nb_accounts has no row with id ${accountId}.`);
    if (a.hubspot_company_id) return a.hubspot_company_id;
    const dupes = await findPossibleDuplicates(a.name, a.website);
    if (dupes.length > 0) {
      const names = dupes.slice(0, 3).map((d) => [d.name, d.city].filter(Boolean).join(", ")).join("; ");
      throw new Error(`${a.name} may already be in HubSpot (${names}). Nothing created; link it to that company first.`);
    }
    const companyId = await createCompany(a);
    await linkAccountCompany(accountId, companyId);
    return companyId;
  });
  return result;
}
