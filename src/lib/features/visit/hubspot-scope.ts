/**
 * The owner verdict behind assertOwnBook, kept pure so a test can run it.
 *
 * A company merged in the portal answers a batch read as its survivor, with
 * the old id only in hs_merged_object_ids. Matching on the returned id alone
 * read every merged company as unowned and refused the filing: 41 of Kyle's
 * stores, merged in HubSpot, could not take a visit (2026-10-28). The owner
 * check runs on the survivor, and the caller files against it.
 */

export type ScopeVerdict = {
  allowed: string[];
  dropped: Array<{ id: string; owner: string | null }>;
  /** Asked id -> the live record it resolves to. Differs only when the asked
   *  company was merged away in the portal. */
  survivor: Record<string, string>;
};

export type LiveCompany = { id: string; properties: Record<string, string | null> };

export function scopeVerdict(asked: string[], live: LiveCompany[], ownerId: string): ScopeVerdict {
  const resolved = new Map<string, { id: string; owner: string | null }>();
  for (const r of live) {
    const rec = { id: r.id, owner: r.properties?.hubspot_owner_id ?? null };
    resolved.set(r.id, rec);
  }
  for (const r of live) {
    for (const merged of (r.properties?.hs_merged_object_ids ?? "").split(";")) {
      if (merged && !resolved.has(merged)) resolved.set(merged, resolved.get(r.id)!);
    }
  }
  const allowed: string[] = [];
  const dropped: ScopeVerdict["dropped"] = [];
  const survivor: Record<string, string> = {};
  for (const id of asked) {
    const rec = resolved.get(id);
    if (rec) survivor[id] = rec.id;
    if (rec?.owner === ownerId) allowed.push(id);
    else dropped.push({ id, owner: rec?.owner ?? null });
  }
  return { allowed, dropped, survivor };
}
