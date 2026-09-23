/**
 * "Search our book": read-only, backs the always-visible search bar above
 * the area picker on the Search screen, for finding an account already in
 * the book rather than sweeping for a new one. Ported from
 * portfolio/src/app/nutribiotic/api/search/book/route.ts.
 *
 * The whole list comes back once and is searched in memory on the client as
 * Juan types, same idiom as the source app. Cached 60 seconds here too.
 */
import { hasAccess } from "../../../../lib/core/devices";
import {
  listAccountsForMatching,
  listBookPlaces,
  type BookAccount,
} from "../../../../lib/features/search/dal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 60_000;

let cache: {
  at: number;
  rows: BookAccount[];
  where: Map<string, { city: string | null; state: string | null }>;
} | null = null;

export async function GET() {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  try {
    if (!cache || Date.now() - cache.at >= CACHE_MS) {
      const [rows, places] = await Promise.all([listAccountsForMatching(), listBookPlaces()]);
      cache = {
        at: Date.now(),
        rows,
        where: new Map(places.map((p) => [p.id, { city: p.city, state: p.state }])),
      };
    }
  } catch {
    return Response.json({ ok: false, error: "Could not read the book." }, { status: 502 });
  }

  const results = cache.rows.map((row) => ({
    id: row.id,
    name: row.name,
    area: row.area,
    tier: row.tier,
    city: cache!.where.get(row.id)?.city ?? null,
    state: cache!.where.get(row.id)?.state ?? null,
  }));

  return Response.json(
    { ok: true, results },
    { headers: { "cache-control": "private, max-age=30" } },
  );
}
