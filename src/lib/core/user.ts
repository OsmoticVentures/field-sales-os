/**
 * Who is signed in. Two reps share this app (migration 0089): Juan, SoCal,
 * HubSpot owner 36242368, and Kyle, NorCal, owner 35219013. A PIN resolves to
 * exactly one nb_users row, and that row is the whole identity:
 *
 *  - ownerId scopes every account read and every HubSpot write. "Your book"
 *    is the signed-in rep's book, never a constant.
 *  - prefsId is the rep's own nb_ui_prefs row, so a route drafted by one rep
 *    never appears on the other's map.
 *  - features lists the screens the rep sees (null = all). The proxy stamps
 *    the request path into x-nb-path and hasAccess() refuses a screen or API
 *    segment outside the list, so hiding a nav item is cosmetic, not the gate.
 *
 * WHO A REQUEST IS. The session cookie names its user; a remembered device's
 * cookie names the user who enrolled it. A request with neither (the Mac
 * bridges' bearer token, the home screen widget's token) is Juan's, because
 * those callers are his and never carry a cookie. Legacy cookies minted before
 * 0089 carry no user and are Juan's for the same reason: every one was his.
 */

import "server-only";
import { readAuthCookies, readDeviceToken, readSessionUser, timingSafeEqual } from "./session";
import { flagsFor } from "./flags";
import type { NbUsersRow } from "../db/types";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

export type User = {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  prefsId: number;
  features: string[] | null;
};

type Row = Pick<
  NbUsersRow,
  "id" | "name" | "hubspot_owner_id" | "owner_name" | "pin_salt" | "pin_hash" | "prefs_id" | "features" | "disabled_at"
>;

export const DEFAULT_USER = "juan";

/** Every screen a rep can be granted, by route segment. An API segment with
 *  one of these names belongs to that screen; any other API segment (account,
 *  enrich, location, planner, health) is shared plumbing every rep needs. */
export const SCREENS = [
  "visit", "route", "prospect", "clients", "search", "plan", "account",
  "expenses", "reports", "fuel", "outbound", "widget",
] as const;

/* Five minutes of memory. The table is two rows and changes by hand; asking
   for it on every request would put a database read in front of every tap. */
const TTL_MS = 5 * 60 * 1000;
let memo: { at: number; rows: Row[] } | null = null;

async function rows(): Promise<Row[]> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.rows;
  if (!SB_URL || !SB_KEY) return [];
  const res = await fetch(
    `${SB_URL}/rest/v1/nb_users?select=id,name,hubspot_owner_id,owner_name,pin_salt,pin_hash,prefs_id,features,disabled_at`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, cache: "no-store" },
  );
  if (!res.ok) throw new Error(`nb_users -> HTTP ${res.status}`);
  const fresh = (await res.json()) as Row[];
  memo = { at: Date.now(), rows: fresh };
  return fresh;
}

const toUser = (r: Row): User => ({
  id: r.id,
  name: r.name,
  ownerId: r.hubspot_owner_id,
  ownerName: r.owner_name,
  prefsId: r.prefs_id,
  features: r.features,
});

export async function userById(id: string): Promise<User | null> {
  const r = (await rows()).find((x) => x.id === id && !x.disabled_at);
  return r ? toUser(r) : null;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The rep this PIN belongs to, or null. Every row is hashed and compared,
 *  match or not, so the time taken says nothing about which PIN is close. */
export async function userByPin(pin: string): Promise<User | null> {
  if (!pin) return null;
  let hit: Row | null = null;
  for (const r of await rows()) {
    const ok = timingSafeEqual(await sha256Hex(`${r.pin_salt}:${pin}`), r.pin_hash);
    if (ok && !r.disabled_at) hit = r;
  }
  return hit ? toUser(hit) : null;
}

/** The user id this request's cookies name, before any registry check. The
 *  gate (devices.ts hasAccess) has already decided whether to let it in. */
export async function currentUserId(): Promise<string> {
  const { session, device } = await readAuthCookies();
  const fromSession = await readSessionUser(session);
  if (fromSession) return fromSession;
  const claimed = await readDeviceToken(device);
  if (claimed) return deviceUser(claimed);
  return DEFAULT_USER;
}

/** The signed-in rep. Throws rather than falling back when the row is gone or
 *  disabled: a request must never quietly become the other rep. */
export async function currentUser(): Promise<User> {
  const id = await currentUserId();
  const u = await userById(id);
  if (!u) throw new Error(`No active user "${id}".`);
  return u;
}

export function canSee(u: User, screen: string): boolean {
  return u.features === null || u.features.includes(screen);
}

/** A remembered device's token claims "<deviceId>~<userId>"; one minted
 *  before 0089 claims a bare device id and is Juan's. */
export function deviceUser(claimed: string): string {
  const at = claimed.indexOf("~");
  return at < 0 ? DEFAULT_USER : claimed.slice(at + 1);
}
export function deviceRowId(claimed: string): string {
  const at = claimed.indexOf("~");
  return at < 0 ? claimed : claimed.slice(0, at);
}

/** The signed-in rep's HubSpot owner id: what "your book" means on every read. */
export async function myOwnerId(): Promise<string> {
  return (await currentUser()).ownerId;
}

/** A per-rep switch (rep-flags.ts, nb_flags) for the signed-in rep, on the server. */
export async function myFlag(name: string): Promise<boolean> {
  return (await flagsFor(await currentUserId())).includes(name);
}
