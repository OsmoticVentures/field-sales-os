/**
 * Find Contacts: the shared shapes between the pipeline (dal.ts, *-pass.ts,
 * pipeline.ts), the route handlers, and the client component. One file so a
 * field added on one side is never silently missed on the other.
 *
 * The source priority is fixed, not a preference (Juan, 2026-09-09, and
 * .claude/agents/nutribiotic-enricher.md): tier 1 the account's own team/
 * about page, tier 2 its own site otherwise, tier 3 Google Places, tier 4 a
 * general web search. A tier-1 name stands even where a weaker tier
 * disagrees, which is why every found person and every proposal carries its
 * own SourceTier rather than a single pass-level one.
 */

export type SourceTier = "site_team" | "site_other" | "places" | "websearch";

/** The same shape the Python side writes (headhunter.py, enrich_places_db.py):
 *  a field's provenance travels with the field, never a blanket "enricher". */
/** `source_tier` is a plain string, not the narrower `SourceTier` union:
 *  a person's provenance uses site_team/site_other/places/websearch, while
 *  an account-level fact (phone, hours) uses the tier chain Juan set for
 *  those fields specifically, manual_note/website/places
 *  (nutribiotic-enricher.md's hours tier chain). Both are written in the
 *  same shape headhunter.py and enrich_hours.py already use. */
export type Provenance = {
  found_by: string;
  at: string;
  basis: string;
  source_tier?: string;
  source_text?: string | null;
  source_url?: string | null;
  note?: string;
};

export type FoundPerson = {
  name: string;
  title: string | null;
  is_decision_maker: boolean;
  source_tier: SourceTier;
  found_by: string;
  basis: string;
  source_text: string | null;
  source_url: string | null;
};

export type FilledField = {
  field: string;
  value: string;
  contact_name?: string;
};

export type Proposal = {
  id: string;
  kind: "contact_field" | "account_field";
  account_id: string;
  contact_id?: string;
  person_name?: string;
  field: string;
  on_file: string | null;
  found: string;
  evidence: string;
  source_tier: SourceTier;
  confidence: "high" | "medium" | "low";
};

export type NotFoundField = { field: string; searched: string };

export type TierOutcome = {
  tier: SourceTier;
  ran: boolean;
  skipped_reason?: string;
  pages_read?: string[];
  failures?: string[];
};

export type FindContactsResult = {
  status: "ok" | "blocked" | "error";
  account_id: string;
  account_name: string;
  error?: string;
  people_found: FoundPerson[];
  contacts_added: number;
  contacts_title_filled: number;
  filled: FilledField[];
  proposals: Proposal[];
  not_found: NotFoundField[];
  tiers: TierOutcome[];
  closed_signal: { note: string; source: string } | null;
  different_business_signal: string | null;
};
