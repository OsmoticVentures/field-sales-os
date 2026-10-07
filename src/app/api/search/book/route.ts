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
import { myOwnerId } from "../../../../lib/core/user";
import {
  listAccountsForMatching,
  listBookPeople,
  listBookPlaces,
  type BookPerson,
  type BookAccount,
} from "../../../../lib/features/search/dal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 60_000;

/* One entry per rep: each rep's book is a different book. */
type Entry = {
  at: number;
  rows: BookAccount[];
  where: Map<string, { city: string | null; state: string | null }>;
  people: BookPerson[];
};
const caches = new Map<string, Entry>();

export async function GET() {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const owner = await myOwnerId();
  let cache = caches.get(owner);
  try {
    if (!cache || Date.now() - cache.at >= CACHE_MS) {
      const [rows, places, people] = await Promise.all([listAccountsForMatching(), listBookPlaces(), listBookPeople()]);
      const inBook = new Set(rows.map((r) => r.id));
      cache = {
        at: Date.now(),
        rows,
        where: new Map(places.map((p) => [p.id, { city: p.city, state: p.state }])),
        people: people.filter((p) => inBook.has(p.account_id)),
      };
      caches.set(owner, cache);
    }
  } catch {
    return Response.json({ ok: false, error: "Could not read the book." }, { status: 502 });
  }

  const companyName = new Map(cache.rows.map((r) => [r.id, r.name]));
  const companies = cache.rows.map((row) => ({
    kind: "company" as const,
    id: row.id,
    name: row.name,
    area: row.area,
    tier: row.tier,
    city: cache.where.get(row.id)?.city ?? null,
    state: cache.where.get(row.id)?.state ?? null,
  }));
  // One master list: every company, then every named person with their
  // company as the subtext. A person opens their company's account.
  const people = cache.people.map((p) => ({
    kind: "person" as const,
    id: p.account_id,
    name: p.name,
    company: companyName.get(p.account_id) ?? null,
    area: null,
    tier: null,
    city: null,
    state: null,
  }));
  const results = [...companies, ...people];

  return Response.json(
    { ok: true, results },
    { headers: { "cache-control": "private, max-age=30" } },
  );
}
