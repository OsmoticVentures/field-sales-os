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
 *    a value already on file stays.
 *  - Provenance on every write: found_by names the real tool and the real
 *    query, at is a real timestamp, basis is the actual evidence.
 *  - Closed is a note, never do_not_visit.
 *  - The account is never re-pointed to another business at the address.
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
} from "./dal";
import { runSitePass, type SitePassResult } from "./site-pass";
import { runPlacesPass, runReviewsPass, type PlacesPassResult } from "./places-pass";
import { distillReviews } from "./review-owners";
import { personFromAccountName } from "./named-practitioner";
import { runWebSearchPass } from "./websearch-pass";
import { isDirectory } from "./html";
import type { FindContactsResult, FoundPerson, Lead } from "./types";
import { myOwnerId } from "../../core/user";

/** Kept under /api/enrich/run's maxDuration (120s) with room to write. */
export const FIND_CONTACTS_BUDGET_MS = 95_000;

function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
}

const TIER_RANK: Record<string, number> = { site_team: 0, site_other: 1, account_name: 2, places_reviews: 3, places: 4, websearch: 5 };

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

export async function runFindContacts(accountId: string): Promise<FindContactsResult> {
  const account = await getEnrichAccount(accountId);
  if (!account) return blocked(accountId, "Account not found.");
  const scopeReason = outOfScopeReason(account, await myOwnerId());
  if (scopeReason) return blocked(accountId, scopeReason, account.name);

  const existing = await listContacts(accountId);
  const existingByName = new Map(existing.map((c) => [normName([c.first_name, c.last_name].filter(Boolean).join(" ")), c]));
  const hasDecisionMakerOnFile = existing.some((c) => c.is_decision_maker);

  const peopleGroups: FoundPerson[][] = [];

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
  if (site.ran) peopleGroups.push(site.people);

  // ---- Tier 3: Google Places --------------------------------------------
  if (places.candidate) {
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
    if (Object.keys(accountPatch).length) await patchAccountBlankFill(accountId, accountPatch, provenance);

    // Said once, when Places first reports it, not on every press.
    if (places.closed && !account.places_status) {
      await insertClosedSignalNote(accountId, `Google Places marks this business as ${places.candidate.businessStatus}.`);
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
    }
  }

  // ---- Tier 3a: Google reviews naming an owner or manager ----------------
  if (!hasDecisionMakerOnFile && !mergePeople(peopleGroups).some((p) => p.is_decision_maker)) {
    const rv = await runReviewsPass(places.candidate?.placeId ?? account.places_id ?? null);
    if (rv.ran) {
      // A bare first name in one review is hearsay; two reviews, or one that
      // prints the full name, is a finding.
      const owners = distillReviews(rv.reviews).filter((o) => o.mentions >= 2 || o.name.trim().includes(" "));
      peopleGroups.push(owners.map((o): FoundPerson => ({
        name: o.name,
        title: o.role.replace(/\b\w/g, (c) => c.toUpperCase()),
        is_decision_maker: true,
        source_tier: "places_reviews",
        found_by: `google reviews: ${o.mentions} mention(s)`,
        basis: `customer reviews name this person as the ${o.role}${o.mentions >= 2 ? `, in ${o.mentions} reviews` : ", by full name"}`,
        source_text: o.sentence,
        source_url: places.candidate?.placeId || account.places_id ? `https://www.google.com/maps/place/?q=place_id:${places.candidate?.placeId ?? account.places_id}` : null,
      })));
    }
  }

  const mergedSoFar = mergePeople(peopleGroups);
  const decisionMakerFoundSoFar = hasDecisionMakerOnFile || mergedSoFar.some((p) => p.is_decision_maker);

  // ---- Tier 4: a general web search, only when still no decision maker --
  if (!decisionMakerFoundSoFar && deadline - Date.now() >= 20_000) {
    const ws = await runWebSearchPass(account.name, account.city, account.state, deadline - 5_000);
    if (ws.ran) {
      peopleGroups.push(ws.people);
      leads.push(...ws.leads);
    }
  }

  // ---- Apply the merged people against nb_contacts ----------------------
  // A name with no role printed beside it is not a contact anyone can ask for.
  const merged = mergePeople(peopleGroups).filter((p) => !!p.title && p.title.trim().length > 0);
  let contactsAdded = 0;
  let contactsUpdated = 0;
  const provAt2 = new Date().toISOString();

  for (const p of merged) {
    const key = normName(p.name);
    const hit: Contact | undefined = existingByName.get(key);
    if (hit) {
      if (!((hit.title || "").trim()) && p.title) {
        await fillContactTitle(hit.id, p.title, { found_by: p.found_by, at: provAt2, basis: p.basis, source_tier: p.source_tier, source_text: p.source_text, source_url: p.source_url });
        contactsUpdated += 1;
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
  if (Object.keys(sitePatch).length) await patchAccountBlankFill(accountId, sitePatch, siteProv);

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

  return {
    status: "ok",
    account_id: accountId,
    account_name: account.name,
    contacts_added: contactsAdded,
    contacts_updated: contactsUpdated,
  };
}

function blocked(accountId: string, error: string, name = ""): FindContactsResult {
  return { status: "blocked", account_id: accountId, account_name: name, error, contacts_added: 0, contacts_updated: 0 };
}
