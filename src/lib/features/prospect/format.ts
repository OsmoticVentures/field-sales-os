/**
 * Small display helpers, ported from the source app's lib/ui.tsx (only the
 * pieces the Prospect screen needs, this port's own copy per PORTING.md
 * rather than an edit to lib/core/ui.tsx).
 */

export const HUBSPOT_COMPANY_URL = (hubspotId: string) => `https://app-eu1.hubspot.com/contacts/148711228/record/0-2/${hubspotId}`;

export function googleMapsUrl(dest: { name?: string | null; address?: string | null; lat?: number | null; lng?: number | null }): string {
  const address = dest.address?.trim();
  const query = address ? [dest.name?.trim(), address].filter(Boolean).join(", ") : dest.lat != null && dest.lng != null ? `${dest.lat},${dest.lng}` : null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query ?? dest.name?.trim() ?? "")}`;
}

export function fullAddress(a: { street: string | null; city: string | null; state: string | null; postal: string | null }): string | null {
  if (!a.street || !a.city) return null;
  return [a.street, a.city, a.state, a.postal].filter(Boolean).join(", ");
}

export function daysAgo(iso: string | null): string {
  if (!iso) return "never";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 60) return `${d}d ago`;
  if (d < 730) return `${Math.round(d / 30)}mo ago`;
  return `${Math.round(d / 365)}y ago`;
}

/** A bare day count for a parameter row ("53 days"), distinct from daysAgo's
 *  coarser bucketing. */
export function exactDaysAgo(iso: string | null): string | null {
  if (!iso) return null;
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return "today";
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** "22 days ago" / "22 days in future" reading of a target date against
 *  today, LA wall-clock date. */
export function dueInDays(iso: string | null): string | null {
  if (!iso) return null;
  const target = new Date(`${iso}T00:00:00`).getTime();
  const today = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" })).getTime();
  const d = Math.round((target - today) / 86_400_000);
  if (d === 0) return "today";
  const n = Math.abs(d);
  return d > 0 ? `${n} day${n === 1 ? "" : "s"} in future` : `${n} day${n === 1 ? "" : "s"} ago`;
}

export function money(n: number | null | undefined): string {
  if (n == null) return "$0";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
