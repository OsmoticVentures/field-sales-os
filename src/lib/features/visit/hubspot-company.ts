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
