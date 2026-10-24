/**
 * A note that says it is a test is never a client interaction. Four of these
 * landed on Spice of Life in September 2026 while the HubSpot write path was
 * being proved, and sat on its account view as if they were real calls.
 *
 * The same patterns are enforced in the database (nb_activities_refuse_test,
 * migration 20261024090000), so a filing from any door is refused; this copy
 * lets the app say so in place before a model call is spent on the note.
 */
const TEST_MARKERS: RegExp[] = [
  /\bOS TEST\b/i,
  /\b(this is|just) a test\b/i,
  /\btest (entry|filing|capture|note|data|visit|call)\b/i,
  /\bnot a real (client )?(interaction|visit|call|meeting)\b/i,
  /\bwrite path\b/i,
  /\bduplicate guard\b/i,
  /\bprove (that )?the .{0,60}(pipeline|hubspot|flags?|write)/i,
  /\bverif(y|ying) (that )?the .{0,60}(pipeline|hubspot|write|flags?)/i,
  /\bwill (be )?delete(d)? .{0,40}(hubspot|immediately|the moment|as soon)/i,
];

export function looksLikeTestFiling(text: string | null | undefined): boolean {
  if (!text) return false;
  return TEST_MARKERS.some((re) => re.test(text));
}

export const TEST_FILING_ERROR = "This note reads as a test, not a real interaction. Nothing was filed.";
