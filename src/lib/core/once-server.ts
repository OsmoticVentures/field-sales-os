/**
 * The server's `once` (./once.ts) over the same Supabase project the rest of
 * the app reads, on nb_idempotency_keys. One instance-wide in-flight map.
 */
import "server-only";
import { makeOnce, postgrestClaimStore } from "./once";

export { Held } from "./once";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

export const once = makeOnce(SB_URL && SB_KEY ? postgrestClaimStore({ url: SB_URL, key: SB_KEY }) : null);

/** The rep's calendar day in the territory's time zone, for content keys. */
export function laDay(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

/** A note's text as a key part: case and spacing do not make it a new note. */
export function noteKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
