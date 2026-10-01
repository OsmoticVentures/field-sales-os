/**
 * Tier 3: Google Places. Structured data, not prose, so nothing here is
 * asked of a model; a field either came back on the candidate or it didn't.
 * Website priority is its own rule, separate from the person-tier ladder
 * (nutribiotic-enricher.md, "what I fill"): Places' own websiteUri is the
 * first choice for a missing `website`, ahead of a general search.
 */
import "server-only";
import { searchPlaces, type PlaceCandidate } from "../../shared/places";
import type { RawReview } from "./review-owners";

export type PlacesPassResult = {
  ran: boolean;
  skipped_reason?: string;
  candidate: PlaceCandidate | null;
  closed: boolean;
};

export async function runPlacesPass(accountName: string, address: string | null, near?: { lat: number; lng: number }): Promise<PlacesPassResult> {
  const query = [accountName, address].filter(Boolean).join(", ");
  if (!query.trim()) return { ran: false, skipped_reason: "No name or address to search Places with.", candidate: null, closed: false };
  try {
    const [candidate] = await searchPlaces(query, 1, near);
    if (!candidate) return { ran: true, skipped_reason: "Places returned no match.", candidate: null, closed: false };
    const closed = candidate.businessStatus === "CLOSED_PERMANENTLY" || candidate.businessStatus === "CLOSED_TEMPORARILY";
    return { ran: true, candidate, closed };
  } catch (err) {
    return { ran: false, skipped_reason: err instanceof Error ? err.message : "Places lookup failed.", candidate: null, closed: false };
  }
}

export type ReviewsPassResult = { ran: boolean; skipped_reason?: string; reviews: RawReview[] };

/** Tier 3a: the storefront's own Google reviews, by the place id already on
 *  the account (or the one the Places pass just matched). The sentence stays
 *  verbatim as the claim; nothing is asked of a model. */
export async function runReviewsPass(placeId: string | null, timeoutMs = 15_000): Promise<ReviewsPassResult> {
  if (!placeId) return { ran: false, skipped_reason: "No Google place id on file.", reviews: [] };
  const key = process.env.NB_PLACES_API_KEY ?? "";
  if (!key) return { ran: false, skipped_reason: "NB_PLACES_API_KEY is not configured.", reviews: [] };
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "reviews" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ran: false, skipped_reason: `Google reviews answered HTTP ${res.status}.`, reviews: [] };
    const data = (await res.json()) as { reviews?: RawReview[] };
    return { ran: true, reviews: data.reviews ?? [] };
  } catch {
    return { ran: false, skipped_reason: "Google reviews could not be read just now.", reviews: [] };
  }
}
