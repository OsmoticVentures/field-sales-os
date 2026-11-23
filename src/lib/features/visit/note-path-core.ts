/**
 * The note path's rules with no I/O, so tests/note-path.test.mts can hold
 * them (and the build refuses a change that breaks them, package.json
 * prebuild). Used by waiting-file.ts (raw filing) and note-drain.ts (the
 * server's HubSpot retry). Pure: no "server-only".
 */

/** Minutes the Mac's read gets before the server files a note raw. */
export const RAW_GRACE_MIN = 20;

/** The kind a note files as before any read: the door he used says call,
 *  email or meeting; everything else from the field is a visit. A field note
 *  is never filed raw (null): it must never reach HubSpot unread. */
export function rawKind(kindOverride: string | null | undefined): string | null {
  if (kindOverride === "field_note") return null;
  if (kindOverride === "call") return "call";
  if (kindOverride === "email") return "email_out";
  if (kindOverride === "meeting") return "meeting";
  return "visit";
}

export const HUBSPOT_BACKOFF_MIN = [10, 20, 40, 80, 160, 360] as const;
/** Tries before a HubSpot retry stops and stays red (nb_note_sweep). */
export const HUBSPOT_MAX_ATTEMPTS = 12;

/** Minutes to wait after a HubSpot miss on this attempt (0-based). */
export function hubspotBackoff(attempts: number): number {
  return HUBSPOT_BACKOFF_MIN[Math.min(Math.max(0, attempts), HUBSPOT_BACKOFF_MIN.length - 1)];
}

/** What one HubSpot try means for its nb_hubspot_retry row. */
export function retryRow(
  activityId: number,
  attempts: number,
  outcome: { ok: true } | { ok: false; error: string; neverFiled?: boolean },
  now = Date.now(),
): Record<string, unknown> {
  const at = new Date(now).toISOString();
  const row: Record<string, unknown> = { activity_id: activityId, attempts: attempts + 1, updated_at: at };
  if (outcome.ok) return { ...row, done_at: at, last_error: null };
  if (outcome.neverFiled) return { ...row, done_at: at, last_error: outcome.error.slice(0, 300) };
  return { ...row, next_at: new Date(now + hubspotBackoff(attempts) * 60_000).toISOString(), last_error: outcome.error.slice(0, 300) };
}
