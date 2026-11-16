/**
 * The caller's address, as the platform saw it, for rate limits and the PIN hold.
 *
 * Order matters. A client can send its own X-Forwarded-For, and a proxy appends
 * to that list, so the FIRST value is whatever the client chose to write. The
 * trustworthy values are the ones the edge sets itself:
 *   1. x-vercel-forwarded-for, set by Vercel and kept even behind another proxy
 *   2. x-real-ip, set by Vercel to the same address
 *   3. the LAST X-Forwarded-For hop, the one our own edge appended
 * Vercel also overwrites X-Forwarded-For today (docs: vercel.com/docs/headers/
 * request-headers), so this is belt and braces, not a fix for a live hole.
 * Off Vercel (next dev) none are set and the fallback names the bucket.
 */
export function clientIp(h: Headers, fallback = "unknown"): string {
  const vercel = h.get("x-vercel-forwarded-for")?.split(",").pop()?.trim();
  if (vercel) return vercel;
  const real = h.get("x-real-ip")?.trim();
  if (real) return real;
  const last = h.get("x-forwarded-for")?.split(",").pop()?.trim();
  return last || fallback;
}
