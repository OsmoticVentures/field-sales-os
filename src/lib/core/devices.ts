/**
 * Remembered devices: the registry behind "stop asking me for the PIN on my
 * own phone." Ported unchanged from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/lib/devices.ts), same table
 * (nb_devices, in the existing Supabase project), same env var names.
 *
 * WHY THIS TALKS TO SUPABASE DIRECTLY rather than through a shared data
 * layer: there is no shared data layer yet in this repo (m5's port of
 * lib/dal.ts has not happened), and this module must stay database-cycle
 * free regardless, since a future data layer's own gate would ask this
 * module, which would ask the data layer.
 *
 * THE THREE PROPERTIES THAT MAKE IT SAFE ENOUGH TO SKIP A PIN:
 *  1. The cookie is HMAC-signed, unforgeable, HttpOnly, scoped to this app.
 *  2. Trust is CAPPED (session.ts, DEVICE_LIMIT).
 *  3. Trust is REVOCABLE per device, enforced here on every request.
 */

import "server-only";
import { cache } from "react";
import { claimedDeviceId, hasValidSession } from "./session";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

const configured = (): boolean => Boolean(SB_URL && SB_KEY);

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SB_URL}/rest/v1/nb_devices${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
}

/** 'dev_<6 hex>', the schema's id shape. Meaningless by design: the cookie
 *  should name a row, not describe the person holding the phone. */
function newDeviceId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `dev_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The device this request is trusted as, or null. `cache()` because one
 * render pass asks this many times and it must not be many round trips.
 */
export const trustedDeviceId = cache(async (): Promise<string | null> => {
  const claimed = await claimedDeviceId();
  if (!claimed || !configured()) return null;

  const params = new URLSearchParams({
    select: "id,last_seen_at",
    id: `eq.${claimed}`,
    revoked_at: "is.null",
    limit: "1",
  });

  let rows: { id: string; last_seen_at: string | null }[];
  try {
    const res = await sb(`?${params}`);
    if (!res.ok) return null;
    rows = (await res.json()) as typeof rows;
  } catch {
    // Fail closed: a device that cannot be confirmed live is not trusted.
    return null;
  }
  if (rows.length === 0) return null;

  void touch(rows[0].id, rows[0].last_seen_at).catch(() => {});
  return rows[0].id;
});

/** Stamp last-seen, but only once every six hours. */
async function touch(id: string, lastSeen: string | null): Promise<void> {
  const stale = !lastSeen || Date.now() - Date.parse(lastSeen) > 6 * 60 * 60 * 1000;
  if (!stale) return;
  try {
    await sb(`?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_seen_at: new Date().toISOString() }),
    });
  } catch {
    // Cosmetic. Must never fail a request.
  }
}

/** The gate every route handler asks: a valid PIN session, or a remembered
 *  device. */
export const hasAccess = cache(async (): Promise<boolean> => {
  if (await hasValidSession()) return true;
  return (await trustedDeviceId()) !== null;
});

export async function liveDeviceCount(): Promise<number> {
  if (!configured()) return 0;
  const res = await sb(`?select=id&revoked_at=is.null`);
  if (!res.ok) return 0;
  return ((await res.json()) as unknown[]).length;
}

/**
 * Enrol this browser, if there is a slot. Called only from the PIN endpoint,
 * after the PIN has been checked: possession of the PIN is what authorizes a
 * device to be remembered.
 *
 * Returns the new id, or null when the cap is full, which the gate reports
 * rather than swallowing.
 */
export async function enrollDevice(label: string, userAgent: string, limit: number): Promise<string | null> {
  if (!configured()) throw new Error("Cannot remember a device: no data source configured.");
  if ((await liveDeviceCount()) >= limit) return null;

  const id = newDeviceId();
  const res = await sb("", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      id,
      label: label.slice(0, 60),
      user_agent: userAgent.slice(0, 300),
      last_seen_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) throw new Error(`nb_devices insert -> HTTP ${res.status}`);
  return id;
}

/** A readable name for a browser, best-effort, from its User-Agent and one
 *  hint the gate sends about which tile it is. Names a row about to be
 *  remembered; authorizes nothing. */
export function deviceLabel(userAgent: string, surface?: string): string {
  const ua = userAgent || "";
  const hardware = /iPhone/i.test(ua)
    ? "iPhone"
    : /iPad/i.test(ua)
      ? "iPad"
      : /Macintosh|Mac OS X/i.test(ua)
        ? "Mac"
        : /Android/i.test(ua)
          ? "Android"
          : /Windows/i.test(ua)
            ? "Windows PC"
            : "Unknown device";
  const where = (surface || "").trim().slice(0, 24);
  return where ? `${hardware} · ${where}` : hardware;
}
