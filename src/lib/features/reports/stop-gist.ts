/**
 * Client-safe: no "server-only" import, so ReportsClient.tsx (a Client
 * Component) can call this directly without pulling dal.ts's Supabase code
 * into the browser bundle.
 */
export type StopGistInput = { events?: Array<{ body?: string | null }> };

/** The first logged event body at a stop, trimmed to one line. Absent, never
 *  a placeholder, when nothing was logged (a call-only or message-only stop
 *  often has no body at all). */
export function stopGist(stop: StopGistInput): string | null {
  const body = (stop.events ?? []).map((e) => e.body?.trim()).find((b) => b);
  if (!body) return null;
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 140).trimEnd()}…` : oneLine;
}
