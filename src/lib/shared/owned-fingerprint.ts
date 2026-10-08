/**
 * Reuse a read of the rep's own nb_accounts rows while they have not moved.
 *
 * Route and Clients read the same few hundred account rows on every open,
 * and those rows change on the scale of edits. Each warm server keeps the
 * last answer per rep and per read, with the fingerprint it was read under:
 * how many accounts the rep owns and the newest updated_at among them. A
 * trigger (accounts_touch) stamps updated_at on every update, so an edit
 * moves the newest stamp, and a row joining or leaving the book moves the
 * count or the stamp. A read asks for the fingerprint first, about a hundred
 * bytes, and only reads the rows again when it moved.
 *
 * Only for reads of nb_accounts columns. Anything derived from other tables
 * (grades, lead stage, scores) changes without touching updated_at and must
 * be read fresh. BOUND: one entry per (read, rep), so it never grows.
 */
import "server-only";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

async function fingerprint(owner: string): Promise<string | null> {
  if (!SB_URL || !SB_KEY) return null;
  const res = await fetch(
    `${SB_URL}/rest/v1/nb_accounts?select=updated_at&hubspot_owner_id=eq.${encodeURIComponent(owner)}&order=updated_at.desc&limit=1`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: "count=exact" }, cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as { updated_at: string }[];
  const total = res.headers.get("content-range")?.split("/")[1];
  return total && total !== "*" ? `${total}|${rows[0]?.updated_at ?? ""}` : null;
}

const memo = new Map<string, { fp: string; value: unknown }>();

export async function whileOwnedRowsUnchanged<T>(name: string, owner: string, read: () => Promise<T>): Promise<T> {
  const key = `${name}:${owner}`;
  // Fingerprint before rows: a write landing in between leaves the copy newer
  // than its fingerprint, so the next call reads again rather than keeping
  // something stale.
  const fp = await fingerprint(owner).catch(() => null);
  const hit = memo.get(key);
  if (fp && hit?.fp === fp) return hit.value as T;
  const value = await read();
  if (fp) memo.set(key, { fp, value });
  else memo.delete(key);
  return value;
}
