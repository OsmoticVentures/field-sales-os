/**
 * PIN session for this app. Ported unchanged from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/session.ts), same env var names, same
 * cookie shape, so the PIN Juan already uses keeps working.
 *
 * Single-user tool: a PIN plus a signed cookie is the whole model, no
 * accounts, no roles, no user table.
 *
 *  - The cookie is SIGNED (HMAC-SHA256), unforgeable client-side, carries
 *    only an expiry, never the PIN.
 *  - PIN comparison is TIMING-SAFE.
 *  - Failed attempts are rate-limited with a lockout.
 *  - Web Crypto only (no node:crypto), so this module runs in the proxy
 *    runtime as well as in route handlers.
 *
 * Env vars (set in Vercel, never committed):
 *   NB_PIN               the PIN itself
 *   NB_SESSION_SECRET    signs the cookie
 */

import { cookies, headers } from "next/headers";

export const COOKIE = "nb_session";
const TTL_SECONDS = 60 * 60 * 8; // 8h, about one working day
const LOCK_MAX = 5;
const LOCK_MINUTES = 15;

/** The remembered-device cookie. Carries a device id, not just an expiry, so
 *  what it proves can be looked up and revoked (see lib/core/devices.ts). */
export const DEVICE_COOKIE = "nb_device";
const DEVICE_TTL_SECONDS = 60 * 60 * 24 * 400; // 400 days, the browser ceiling

/** How many devices may ever be remembered. Overridable with NB_DEVICE_LIMIT
 *  without a deploy. */
export const DEVICE_LIMIT = Math.max(1, Number(process.env.NB_DEVICE_LIMIT) || 20);

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(payload: string): Promise<string> {
  const secret = process.env.NB_SESSION_SECRET;
  if (!secret) throw new Error("NB_SESSION_SECRET is not set");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return b64url(new Uint8Array(sig));
}

/** Constant-time string compare. Never replace this with ===. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function mintToken(): Promise<string> {
  const exp = Date.now() + TTL_SECONDS * 1000;
  const payload = String(exp);
  return `${payload}.${await hmac(payload)}`;
}

/** Verify a token's signature and expiry. Pure and dependency-free, so proxy
 *  can call it without importing anything that touches a database. */
export async function verifyToken(token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const idx = token.lastIndexOf(".");
  if (idx < 1) return false;
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);

  let expected: string;
  try {
    expected = await hmac(payload);
  } catch {
    return false;
  }
  if (!timingSafeEqual(sig, expected)) return false;

  const exp = Number(payload);
  return Number.isFinite(exp) && Date.now() < exp;
}

/** Mint a remembered-device token: signs `<deviceId>.<expiry>` so neither
 *  half can be edited. */
export async function mintDeviceToken(deviceId: string): Promise<string> {
  const payload = `${deviceId}.${Date.now() + DEVICE_TTL_SECONDS * 1000}`;
  return `${payload}.${await hmac(payload)}`;
}

/** The device id a well-signed, unexpired token claims, or null. Says
 *  nothing about whether that device is still trusted, see devices.ts. */
export async function readDeviceToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const sigAt = token.lastIndexOf(".");
  if (sigAt < 1) return null;
  const payload = token.slice(0, sigAt);
  const sig = token.slice(sigAt + 1);

  let expected: string;
  try {
    expected = await hmac(payload);
  } catch {
    return null;
  }
  if (!timingSafeEqual(sig, expected)) return null;

  const expAt = payload.lastIndexOf(".");
  if (expAt < 1) return null;
  const exp = Number(payload.slice(expAt + 1));
  if (!Number.isFinite(exp) || Date.now() >= exp) return null;
  return payload.slice(0, expAt);
}

/**
 * Both auth cookies, read once. `cookies()` is async in Next 16 and only
 * resolves inside the request's own async chain, so this is the ONE place
 * outside the PIN endpoint that touches the jar: callers await it at the top
 * of a route handler or layout and pass the raw values down to the pure
 * verifiers above. Never call it from module scope, from inside a `cache()`d
 * or `"use cache"` function, or after the response has been returned.
 */
export type AuthCookies = { session: string | undefined; device: string | undefined };

export async function readAuthCookies(): Promise<AuthCookies> {
  const jar = await cookies();
  return { session: jar.get(COOKIE)?.value, device: jar.get(DEVICE_COOKIE)?.value };
}

/** The device id claimed by this request's cookie, signature-checked only. */
export async function claimedDeviceId(): Promise<string | null> {
  const { device } = await readAuthCookies();
  return readDeviceToken(device);
}

/** The one gate every route handler calls: a valid signed session cookie. */
export async function hasValidSession(): Promise<boolean> {
  const { session } = await readAuthCookies();
  return verifyToken(session);
}

/** Used by the PIN endpoint to label a remembered device with which tile
 *  installed it; kept here so session.ts stays the one module that reads
 *  request headers for auth purposes. */
export async function requestUserAgent(): Promise<string> {
  return (await headers()).get("user-agent") ?? "";
}

/**
 * Lockout state. In-memory, which is the honest choice for a single-user
 * tool on serverless: it resets on cold start, a speed bump rather than a
 * vault, raising the cost of online brute force by orders of magnitude.
 */
type Attempts = { count: number; lockedUntil: number };
const attempts: Attempts = { count: 0, lockedUntil: 0 };

export function lockRemainingMs(): number {
  return Math.max(0, attempts.lockedUntil - Date.now());
}

export function registerFailure(): { locked: boolean; left: number } {
  attempts.count += 1;
  if (attempts.count >= LOCK_MAX) {
    attempts.lockedUntil = Date.now() + LOCK_MINUTES * 60_000;
    attempts.count = 0;
    return { locked: true, left: 0 };
  }
  return { locked: false, left: LOCK_MAX - attempts.count };
}

export function registerSuccess(): void {
  attempts.count = 0;
  attempts.lockedUntil = 0;
}

export function checkPin(candidate: string): boolean {
  const real = process.env.NB_PIN;
  if (!real) return false;
  return timingSafeEqual(candidate, real);
}

export const SESSION_TTL_SECONDS = TTL_SECONDS;
export const DEVICE_TTL = DEVICE_TTL_SECONDS;
export const LOCKOUT_MINUTES = LOCK_MINUTES;
