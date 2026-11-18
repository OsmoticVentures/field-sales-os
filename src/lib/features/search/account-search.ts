/**
 * ONE ACCOUNT SEARCH FOR EVERY PICKER (2026-11-17). Typing "Ramiro" found
 * nothing because the picker only read the business name. Ramiro owns One
 * More Rep Sports Performance, and his name lives on nb_contacts.
 *
 * Every picker that finds an account calls this: the account's own fields
 * plus the names of the people on it go through the same matcher, so a first
 * name, a last name, or both finds the business. When the person is what
 * matched, the hit carries that name so the row can show it under the
 * business. Pure, no I/O; the people come from /api/search/book (one cached
 * read, searched locally, no request per keystroke).
 */
import { matchScore, rankMatches } from "./search-match";

export type PeopleByAccount = ReadonlyMap<string, readonly string[]>;

export type AccountHit<A> = { account: A; person: string | null };

type Searchable = { id: string; name: string; city?: string | null; state?: string | null; area?: string | null };

export function searchAccountsAndPeople<A extends Searchable>(
  query: string,
  accounts: readonly A[],
  people: PeopleByAccount,
  limit = 8,
): AccountHit<A>[] {
  const own = (a: A) => [a.city, a.state, a.area];
  const ranked = rankMatches(query, accounts, (a) => ({ name: a.name || "", also: [...own(a), ...(people.get(a.id) ?? [])] }), limit);
  return ranked.map((account) => {
    // Show a person only when the business itself did not carry the query.
    if (matchScore(query, { name: account.name || "", also: own(account) }) !== null) return { account, person: null };
    const names = people.get(account.id) ?? [];
    const best = rankMatches(query, names, (n) => ({ name: n }), 1)[0];
    const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
    const loose = names.find((n) => tokens.some((t) => n.toLowerCase().includes(t)));
    return { account, person: best ?? loose ?? null };
  });
}

export function groupPeople(people: readonly { account_id?: string; id: string; kind?: string; name: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of people) {
    if (p.kind !== "person") continue;
    const list = out.get(p.id) ?? [];
    if (!list.includes(p.name)) list.push(p.name);
    out.set(p.id, list);
  }
  return out;
}
