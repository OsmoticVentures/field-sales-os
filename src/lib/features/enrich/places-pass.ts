/**
 * Tier 3: Google Places. Structured data, not prose, so nothing here is
 * asked of a model; a field either came back on the candidate or it didn't.
 * Website priority is its own rule, separate from the person-tier ladder
 * (nutribiotic-enricher.md, "what I fill"): Places' own websiteUri is the
 * first choice for a missing `website`, ahead of a general search.
 */
import "server-only";
import { searchPlaces, type PlaceCandidate } from "../../shared/places";

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
