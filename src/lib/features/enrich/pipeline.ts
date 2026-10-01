/**
 * One account, tiers 1 through 4, end to end. This is the in-app merge of
 * two Mac-side agents this department already trusts (headhunter.py's own-
 * site read, tiers 1-2, and nutribiotic-enricher's Places and web-search
 * tiers, 3-4) into a single on-demand pass that runs from the phone at the
 * store door, where neither a Mac nor Claude Code is available.
 *
 * THE RULES THIS FILE ENFORCES, all from nutribiotic-enricher.md and this
 * milestone's brief, not a preference:
 *  - Source priority is fixed: a tier-1 name stands even where a weaker tier
 *    disagrees. mergePeople below keeps the first (strongest-tier) hit for
 *    a given name and never lets a later, weaker finding replace it.
 *  - Blank-fill only. Every write re-reads the live row first (dal.ts), and
 *    a disagreement comes back as a Proposal, never a silent overwrite.
 *  - Provenance on every write: found_by names the real tool and the real
 *    query, at is a real timestamp, basis is the actual evidence.
 *  - Closed is a note, never do_not_visit.
 *  - A different business at the address is reported and the account is
 *    never re-pointed.
 *  - Never touches HubSpot, ever.
 */
import "server-only";
import {
  fillContactTitle,
  getEnrichAccount,
  insertClosedSignalNote,
  insertFoundContact,
  listContacts,
  outOfScopeReason,
  patchAccountBlankFill,
  stampSearchMarker,
  type Contact,
  type EnrichAccount,
} from "./dal";
import { runSitePass, type SitePassResult } from "./site-pass";
import { runPlacesPass, runReviewsPass, type PlacesPassResult } from "./places-pass";
import { distillReviews } from "./review-owners";
import { personFromAccountName } from "./named-practitioner";
import { runWebSearchPass } from "./websearch-pass";
import { isDirectory } from "./html";
import type { FilledField, FindContactsResult, FoundPerson, Lead, NotFoundField, Proposal, TierOutcome } from "./types";

/** Kept under /api/enrich/run's maxDuration (120s) with room to write. */
export const FIND_CONTACTS_BUDGET_MS = 95_000;

function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
}

const TIER_RANK: Record<string, number> = { site_team: 0, site_other: 1, account_name: 2, places_reviews: 3, places: 4, websearch: 5 };
const TIER_CONFIDENCE: Record<string, "high" | "medium" | "low"> = { site_team: "high", site_other: "medium", account_name: "high", places_reviews: "medium", places: "medium", websearch: "low" };

/** Every found person across every tier that ran, one entry per real human,
 *  strongest tier wins the title/decision-maker call, exactly headhunter.py's
 *  own merge rule for the same name met on two pages. */
function mergePeople(groups: FoundPerson[][]): FoundPerson[] {
  const byName = new Map<string, FoundPerson>();
  for (const group of groups) {
    for (const p of group) {
      const key = normName(p.name);
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing || TIER_RANK[p.source_tier] < TIER_RANK[existing.source_tier]) byName.set(key, p);
    }
  }
  return [...byName.values()].sort(
    (a, b) => TIER_RANK[a.source_tier] - TIER_RANK[b.source_tier] || Number(b.is_decision_maker) - Number(a.is_decision_maker),
  );
}

function nameParts(name: string): { first: string; last: string | null } {
  const parts = name.trim().split(/\s+/);
  return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(" ") : null };
}

/** A quick, no-fabrication check for "this candidate is a different business
 *  at the same rough address", never used to re-point an account, only to
 *  surface the mismatch (nutribiotic-enricher.md: "the match is a
 *  suggestion... I say so and stop"). */
function differentBusinessSignal(account: EnrichAccount, candidateName: string, candidateStreet: string | null): string | null {
  if (!candidateName) return null;
  const a = normName(account.name);
  const c = normName(candidateName);
  if (!a || !c) return null;
  const overlap = a.split(" ").some((w) => w.length > 2 && c.includes(w)) || c.split(" ").some((w) => w.length > 2 && a.includes(w));
  if (overlap) return null;
  if (account.street && candidateStreet) {
    const aNum = account.street.match(/^\d+/)?.[0];
    const cNum = candidateStreet.match(/^\d+/)?.[0];
    if (aNum && cNum && aNum === cNum) {
      return `Google Places lists "${candidateName}" at this address, a different name than the account ("${account.name}"). This may be a different business now at the same address.`;
    }
  }
  return null;
}

export async function runFindContacts(accountId: string): Promise<FindContactsResult> {
  const account = await getEnrichAccount(accountId);
  if (!account) return blocked(accountId, "Account not found.");
  const scopeReason = outOfScopeReason(account);
  if (scopeReason) return blocked(accountId, scopeReason, account.name);

  const existing = await listContacts(accountId);
  const existingByName = new Map(existing.map((c) => [normName([c.first_name, c.last_name].filter(Boolean).join(" ")), c]));
  const hasDecisionMakerOnFile = existing.some((c) => c.is_decision_maker);

  const tiers: TierOutcome[] = [];
  const peopleGroups: FoundPerson[][] = [];
  const filled: FilledField[] = [];
  const proposals: Proposal[] = [];
  const notFound: NotFoundField[] = [];
  let closedSignal: FindContactsResult["closed_signal"] = null;
  let differentBusiness: string | null = null;

  // The route allows FIND_CONTACTS_BUDGET_MS; every tier below spends from
  // this one clock, so a slow site shortens the web search rather than the
  // whole pass dying at the limit with nothing saved.
  const deadline = Date.now() + FIND_CONTACTS_BUDGET_MS;
  const leads: Lead[] = [];

  // A practice named for its practitioner ("BETTY CIUCHTA, D.C.") is that
  // person. Deterministic and free, so it always runs; the claim is the
  // stored account name itself.
  const named = personFromAccountName(account.name);
  if (named) {
    peopleGroups.push([{
      name: named.name, title: named.title, is_decision_maker: true, source_tier: "account_name",
      found_by: "account name",
      basis: `the business is registered under this person's own name and credential (${named.credential}), a sole practice; title is the credential spelled out`,
      source_text: account.name, source_url: null,
    }]);
  }

  // ---- Head Hunter first: tiers 1-2, the account's own site ---------------
  // Juan, 2026-09-30: Head Hunter is the top priority in every enrichment run.
  // The site read starts before anything else and is listed first in the
  // result. Places runs beside it (independent reads, so no waiting), but it is
  // bounded, and neither can take the other down: a thrown error in one is
  // stated in that tier's own line and the other's findings are still saved.
  const address = [account.street, account.city, account.state].filter(Boolean).join(", ");
  const near = account.lat != null && account.lng != null ? { lat: account.lat, lng: account.lng } : undefined;
  const sitePromise = runSitePass(account.website, account.name, { deadline: deadline - 20_000 });
  const placesPromise = Promise.race([
    runPlacesPass(account.name, address || null, near),
    new Promise<PlacesPassResult>((resolve) =>
      setTimeout(() => resolve({ ran: false, skipped_reason: "Google Places took too long; run it again.", candidate: null, closed: false }), 25_000),
    ),
  ]);
  const [siteSettled, placesSettled] = await Promise.allSettled([sitePromise, placesPromise]);
  let site: SitePassResult =
    siteSettled.status === "fulfilled"
      ? siteSettled.value
      : { ran: false, skipped_reason: `The website read failed: ${siteSettled.reason instanceof Error ? siteSettled.reason.message : "unknown error"}. Nothing was guessed.`, pages_read: [], failures: [], people: [], names_without_role: [], site_phone: null, site_email: null, site_hours: null, socials: {} };
  const places: PlacesPassResult =
    placesSettled.status === "fulfilled"
      ? placesSettled.value
      : { ran: false, skipped_reason: "Google Places failed.", candidate: null, closed: false };
  tiers.push({ tier: "site_team", ran: site.ran, skipped_reason: site.skipped_reason, pages_read: site.pages_read, failures: site.failures });
  if (site.ran) peopleGroups.push(site.people);

  // ---- Tier 3: Google Places --------------------------------------------
  tiers.push({ tier: "places", ran: places.ran, skipped_reason: places.skipped_reason });

  if (places.candidate) {
    differentBusiness = differentBusinessSignal(account, places.candidate.name, places.candidate.street);
    const provAt = new Date().toISOString();
    const accountPatch: Record<string, unknown> = {};
    const provenance: Record<string, { found_by: string; at: string; basis: string; source_tier: "places" }> = {};

    if (!account.website && places.candidate.website) {
      accountPatch.website = places.candidate.website;
      provenance.website = { found_by: "google_places: place details", at: provAt, basis: "Places websiteUri", source_tier: "places" };
    }
    if (!account.phone && places.candidate.phone) {
      accountPatch.phone = places.candidate.phone;
      provenance.phone = { found_by: "google_places: place details", at: provAt, basis: "Places nationalPhoneNumber", source_tier: "places" };
    } else if (account.phone && places.candidate.phone && account.phone.replace(/\D/g, "").slice(-10) !== places.candidate.phone.replace(/\D/g, "").slice(-10)) {
      proposals.push({
        id: `${accountId}:account_field:phone`, kind: "account_field", account_id: accountId, field: "phone",
        on_file: account.phone, found: places.candidate.phone, evidence: "Google Places lists a different number.", source_tier: "places", confidence: "medium",
      });
    }
    if (!account.places_id && places.candidate.placeId) {
      accountPatch.places_id = places.candidate.placeId;
      provenance.places_id = { found_by: "google_places: place details", at: provAt, basis: "Places place id", source_tier: "places" };
    }
    if (!account.places_status && places.candidate.businessStatus) {
      accountPatch.places_status = places.candidate.businessStatus;
      provenance.places_status = { found_by: "google_places: place details", at: provAt, basis: "Places businessStatus", source_tier: "places" };
    }
    if (!account.places_rating && places.candidate.rating != null) {
      accountPatch.places_rating = places.candidate.rating;
      provenance.places_rating = { found_by: "google_places: place details", at: provAt, basis: "Places rating", source_tier: "places" };
    }
    if (!account.places_rating_count && places.candidate.ratingCount != null) {
      accountPatch.places_rating_count = places.candidate.ratingCount;
      provenance.places_rating_count = { found_by: "google_places: place details", at: provAt, basis: "Places userRatingCount", source_tier: "places" };
    }
    if (!account.places_primary_type && places.candidate.primaryType) {
      accountPatch.places_primary_type = places.candidate.primaryType;
      provenance.places_primary_type = { found_by: "google_places: place details", at: provAt, basis: "Places primaryType", source_tier: "places" };
    }
    if (!account.lat && places.candidate.lat != null) accountPatch.lat = places.candidate.lat;
    if (!account.lng && places.candidate.lng != null) accountPatch.lng = places.candidate.lng;
    if (Object.keys(accountPatch).length) {
      await patchAccountBlankFill(accountId, accountPatch, provenance);
      for (const [field, value] of Object.entries(accountPatch)) filled.push({ field, value: String(value) });
    }

    if (places.closed) {
      closedSignal = { note: `Google Places marks this business as ${places.candidate.businessStatus}.`, source: "google_places" };
      await insertClosedSignalNote(accountId, closedSignal.note);
    }
  }

  // Compounding: Places just filled a website this account never had.
  // Read it back to run tier 1-2 against it, the same value tier 4 would
  // otherwise be the only chance to find a person on.
  if (!account.website && places.candidate?.website && !isDirectory(places.candidate.website)) {
    const second = await runSitePass(places.candidate.website, account.name, { deadline: deadline - 15_000 });
    if (second.ran) {
      peopleGroups.push(second.people);
      site = { ...site, pages_read: [...site.pages_read, ...second.pages_read], failures: [...site.failures, ...second.failures] };
      tiers[0] = { ...tiers[0], ran: true, pages_read: site.pages_read, failures: site.failures };
    }
  }

  // ---- Tier 3a: Google reviews naming an owner or manager ----------------
  if (!hasDecisionMakerOnFile && !mergePeople(peopleGroups).some((p) => p.is_decision_maker)) {
    const rv = await runReviewsPass(places.candidate?.placeId ?? account.places_id ?? null);
    tiers.push({ tier: "places_reviews", ran: rv.ran, skipped_reason: rv.skipped_reason });
    if (rv.ran) {
      const owners = distillReviews(rv.reviews);
      peopleGroups.push(owners.map((o): FoundPerson => ({
        name: o.name,
        title: o.role.replace(/\b\w/g, (c) => c.toUpperCase()),
        is_decision_maker: o.mentions >= 2,
        source_tier: "places_reviews",
        found_by: `google reviews: ${o.mentions} mention(s)`,
        basis: `a customer's review names this person as the ${o.role}${o.mentions >= 2 ? ", in more than one review" : ", in a single review; decision-maker flag left to a person"}`,
        source_text: o.sentence,
        source_url: places.candidate?.placeId || account.places_id ? `https://www.google.com/maps/place/?q=place_id:${places.candidate?.placeId ?? account.places_id}` : null,
      })));
    }
  }

  const mergedSoFar = mergePeople(peopleGroups);
  const decisionMakerFoundSoFar = hasDecisionMakerOnFile || mergedSoFar.some((p) => p.is_decision_maker);

  // ---- Tier 4: a general web search, only when still no decision maker --
  let webSearchRan = false;
  if (!decisionMakerFoundSoFar && deadline - Date.now() < 20_000) {
    tiers.push({ tier: "websearch", ran: false, skipped_reason: "The website read used the time a web search needs. Run it again to search." });
  } else if (!decisionMakerFoundSoFar) {
    const ws = await runWebSearchPass(account.name, account.city, account.state, deadline - 5_000);
    webSearchRan = ws.ran;
    tiers.push({ tier: "websearch", ran: ws.ran, skipped_reason: ws.skipped_reason });
    if (ws.ran) {
      peopleGroups.push(ws.people);
      leads.push(...ws.leads);
      if (ws.closed_signal) {
        closedSignal = closedSignal ?? { note: `A web search suggests this business may have closed: "${ws.closed_signal}"`, source: `websearch: "${ws.query}"` };
        await insertClosedSignalNote(accountId, closedSignal.note);
      }
    }
  } else {
    tiers.push({ tier: "websearch", ran: false, skipped_reason: "A decision maker is already on file or was found this pass; tier 4 was not spent." });
  }

  // ---- Apply the merged people against nb_contacts ----------------------
  const merged = mergePeople(peopleGroups);
  let contactsAdded = 0;
  let contactsTitleFilled = 0;
  const provAt2 = new Date().toISOString();

  for (const p of merged) {
    const key = normName(p.name);
    const hit: Contact | undefined = existingByName.get(key);
    if (hit) {
      if (!((hit.title || "").trim()) && p.title) {
        await fillContactTitle(hit.id, p.title, { found_by: p.found_by, at: provAt2, basis: p.basis, source_tier: p.source_tier, source_text: p.source_text, source_url: p.source_url });
        contactsTitleFilled += 1;
        filled.push({ field: "title", value: p.title, contact_name: p.name });
      } else if (p.title && (hit.title || "").trim().toLowerCase() !== p.title.toLowerCase()) {
        proposals.push({
          id: `${accountId}:contact_field:${hit.id}:title`, kind: "contact_field", account_id: accountId, contact_id: hit.id, person_name: p.name,
          field: "title", on_file: hit.title, found: p.title, evidence: `${p.found_by}. ${p.basis}`, source_tier: p.source_tier, confidence: TIER_CONFIDENCE[p.source_tier],
        });
      }
      if (p.is_decision_maker && !hit.is_decision_maker) {
        proposals.push({
          id: `${accountId}:contact_field:${hit.id}:is_decision_maker`, kind: "contact_field", account_id: accountId, contact_id: hit.id, person_name: p.name,
          field: "is_decision_maker", on_file: "No", found: "Yes", evidence: `${p.found_by}. ${p.basis}`, source_tier: p.source_tier, confidence: TIER_CONFIDENCE[p.source_tier],
        });
      }
      continue;
    }
    const { first, last } = nameParts(p.name);
    const prov = { found_by: p.found_by, at: provAt2, basis: p.basis, source_tier: p.source_tier, source_text: p.source_text, source_url: p.source_url };
    const row = await insertFoundContact({
      account_id: accountId,
      first_name: first,
      last_name: last,
      title: p.title,
      is_decision_maker: p.is_decision_maker,
      enrichment_status: p.title
        ? { first_name: prov, last_name: prov, title: prov, is_decision_maker: prov }
        : { first_name: prov, last_name: prov },
    });
    if (row) {
      contactsAdded += 1;
      existingByName.set(key, row);
    }
  }

  // ---- Compounding account fields the site pass turned up ---------------
  const sitePatch: Record<string, unknown> = {};
  const siteProv: Record<string, { found_by: string; at: string; basis: string; source_tier: "website" }> = {};
  const siteSourceUrl = site.pages_read[0];
  if (site.site_phone && !account.phone) {
    sitePatch.phone = site.site_phone;
    siteProv.phone = { found_by: `website: ${siteSourceUrl}`, at: provAt2, basis: "phone printed on the business's own site", source_tier: "website" };
  } else if (site.site_phone && account.phone && account.phone.replace(/\D/g, "").slice(-10) !== site.site_phone.replace(/\D/g, "").slice(-10)) {
    proposals.push({
      id: `${accountId}:account_field:phone_site`, kind: "account_field", account_id: accountId, field: "phone",
      on_file: account.phone, found: site.site_phone, evidence: `The number printed on ${siteSourceUrl} does not match the number on file.`, source_tier: "site_other", confidence: "medium",
    });
  }
  if (site.site_email && !account.email) {
    sitePatch.email = site.site_email;
    siteProv.email = { found_by: `website: ${siteSourceUrl}`, at: provAt2, basis: "mailto link on the business's own site", source_tier: "website" };
  }
  const hoursTier = ((account.enrichment_status || {}) as Record<string, { source_tier?: string }>).business_hours?.source_tier;
  if (site.site_hours && hoursTier !== "manual_note") {
    sitePatch.business_hours = site.site_hours;
    siteProv.business_hours = { found_by: `website: ${siteSourceUrl}`, at: provAt2, basis: "hours printed on the business's own site", source_tier: "website" };
  }
  for (const [field, url] of Object.entries(site.socials)) {
    if (!(account as unknown as Record<string, unknown>)[field]) {
      sitePatch[field] = url;
      siteProv[field] = { found_by: `website: ${siteSourceUrl}`, at: provAt2, basis: "link on the business's own site", source_tier: "website" };
    }
  }
  if (Object.keys(sitePatch).length) {
    await patchAccountBlankFill(accountId, sitePatch, siteProv);
    for (const [field, value] of Object.entries(sitePatch)) filled.push({ field, value: typeof value === "string" ? value : "updated" });
  }

  // ---- What's still missing, for the "could not find" list --------------
  const filledFields = new Set(filled.map((f) => f.field));
  const stillHasDecisionMaker = existing.some((c) => c.is_decision_maker) || merged.some((p) => p.is_decision_maker);
  if (!stillHasDecisionMaker) notFound.push({ field: "decision maker", searched: webSearchRan ? "site, Places, and a web search" : "site and Places" });
  if (!account.website && !filledFields.has("website")) notFound.push({ field: "website", searched: "Places and the account's own name" });
  if (!account.phone && !filledFields.has("phone")) notFound.push({ field: "phone", searched: "the site and Places" });
  if (!account.email && !filledFields.has("email")) notFound.push({ field: "email", searched: "the site" });

  // ---- The marker, on every outcome, including "nobody found" -----------
  await stampSearchMarker(accountId, {
    at: provAt2,
    found_by: site.pages_read.length ? `website: ${site.pages_read.join(", ")}` : "find_contacts: no website read",
    basis: site.skipped_reason || `${site.pages_read.length} page(s) read on the business's own site`,
    found: merged.length,
    tier: merged[0]?.source_tier ?? null,
    note: "in-app pass (Find Contacts): tiers 1-4 in one run, not headhunter.py's own-site-only pass.",
    ...(leads.length ? { leads } : {}),
    ...(site.failures.length ? { failures: site.failures.slice(0, 4) } : {}),
  });

  // A dismissed proposal never resurfaces on a later run, the same way a
  // curated value already on file would not; see dal.ts's dismissProposal.
  const dismissed = new Set(
    Array.isArray((account.enrichment_status as Record<string, unknown> | null)?.dismissed_proposals)
      ? ((account.enrichment_status as Record<string, unknown>).dismissed_proposals as string[])
      : [],
  );

  return {
    status: "ok",
    account_id: accountId,
    account_name: account.name,
    people_found: merged,
    contacts_added: contactsAdded,
    contacts_title_filled: contactsTitleFilled,
    filled,
    proposals: proposals.filter((p) => !dismissed.has(p.id)),
    not_found: notFound,
    tiers,
    closed_signal: closedSignal,
    different_business_signal: differentBusiness,
    leads,
  };
}

function blocked(accountId: string, error: string, name = ""): FindContactsResult {
  return {
    status: "blocked",
    account_id: accountId,
    account_name: name,
    error,
    people_found: [],
    contacts_added: 0,
    contacts_title_filled: 0,
    filled: [],
    proposals: [],
    not_found: [],
    tiers: [],
    closed_signal: null,
    different_business_signal: null,
    leads: [],
  };
}
