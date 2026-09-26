/**
 * The Route map's own extra read: territory areas, the priority book (for
 * the pin card's score badge) and the show-chains/practices/prospects
 * prefs. Accounts themselves already ride on /api/route/state (the same
 * listOwnerAccounts the day list reads), so this is only what that route
 * does not carry, to keep this a small second round trip rather than a
 * duplicated account fetch.
 *
 * Reuses getPriorityBook/listAreas from lib/features/prospect/dal.ts
 * (already ported there for the Prospect/SDR screen) rather than
 * duplicating either, per PORTING.md.
 */
import { getPriorityBook, listAreas } from "../../../../lib/features/prospect/dal";
import { getMapDisplayPrefs } from "../../../../lib/features/route/dal";
import type { AccountPriority } from "../../../../lib/features/route/types";
import { hasAccess } from "../../../../lib/core/devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }

  try {
    const [areas, priority, displayPrefs] = await Promise.all([listAreas(), getPriorityBook(), getMapDisplayPrefs()]);

    // Flattened to a plain object: a Map does not cross the client boundary,
    // and only score/reason/band are ever drawn, same trim map/page.tsx does
    // in the source app.
    const priorityById: Record<string, AccountPriority> = {};
    for (const [id, r] of priority.byId) {
      if (r.score !== null) priorityById[id] = { score: r.score, reason: r.reason, band: r.band };
    }

    return Response.json({ ok: true, areas, priorityById, displayPrefs }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't load the map." }, { status: 500 });
  }
}
