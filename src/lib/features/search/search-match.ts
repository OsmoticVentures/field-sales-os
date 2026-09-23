/**
 * Ported unchanged from portfolio/src/app/nutribiotic/lib/search-match.ts.
 * That file is shared core there (Search Map and Route Planner both use it);
 * this port only needs it for Search Map's "Search our book" box, so it is
 * copied here rather than into a shared lib/shared/ module this feature does
 * not own. If Route Planner's port also needs it, move this one file to
 * lib/shared/search-match.ts in an integration pass rather than keeping two
 * copies (see this port's report).
 *
 * ONE MATCHER FOR EVERY SEARCH BOX IN THIS OS (2026-09-17).
 *
 * Juan typed "Shine natural market, Encinitas" into the map's client field and
 * was told "No account of yours by that name." Shine Natural Market, Encinitas
 * is in his book, and typing "Shine" alone had just found it. Every box in the
 * OS carried its own copy of the same naive rule -- the whole query, as one
 * string, tested against one field -- so all of them failed the moment anyone
 * typed the way people actually type: the name plus the city, a comma, a
 * plural, a letter in the wrong place.
 *
 * THE RULE, IN ONE LINE: every word of the query has to land somewhere on the
 * record, rather than the whole sentence having to land in one field.
 *
 * RANK STILL DECIDES WHAT HE SEES FIRST. Forgiving on what matches, strict on
 * what leads: an exact name, then a name the query prefixes, then every word
 * hitting the start of a word in the name, and only then the looser tiers
 * where the city carried part of the query or a letter was off. A typo or a
 * city hit can put a row IN the list; it cannot push it past the row whose
 * name Juan actually typed.
 *
 * ALIASES APPLY TO BOTH SIDES, so canonicalizing "st" to "street" cannot
 * misfire: the record is folded the same way the query is, and the only thing
 * it costs is that "Dr. Pure Nature" and a Drive read alike in a name search,
 * which no one has ever needed kept apart.
 *
 * A SERVER SEARCH IS STILL ONE SUBSTRING. Boxes backed by PostgREST ilike or
 * HubSpot's CONTAINS_TOKEN cannot express any of this, so they fetch on the
 * most selective single word (selectiveTokens) and rank what comes back
 * through matchScore here, which is the same rule, just applied one step
 * later.
 */

/** Folded to lowercase ASCII with punctuation as space, so a comma, a period,
 *  an ampersand or an accent never decides whether a name matches. */
export function normalizeSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchTokens(query: string): string[] {
  const n = normalizeSearch(query);
  return n ? n.split(" ") : [];
}

/** Words a query can carry and a record can lack without either being wrong.
 *  An unmatched one is skipped rather than failing the whole query, which is
 *  what lets "the vitamin shoppe" find Vitamin Shoppe. */
const OPTIONAL = new Set(["the", "a", "an", "of", "and", "at", "in", "on", "for", "dba", "inc", "llc", "ltd", "corp"]);

/** Both sides get folded through this, so it can only ever make two spellings
 *  of one word agree. */
const ALIAS: Record<string, string> = {
  st: "street",
  ste: "suite",
  ave: "avenue",
  av: "avenue",
  blvd: "boulevard",
  rd: "road",
  dr: "drive",
  hwy: "highway",
  ln: "lane",
  ctr: "center",
  centre: "center",
  mkt: "market",
  co: "company",
  intl: "international",
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  mt: "mount",
  ft: "fort",
  pharm: "pharmacy",
  nutr: "nutrition",
};

function canon(word: string): string {
  return ALIAS[word] ?? word;
}

/** One edit for a word long enough that a single slip is obviously a slip, two
 *  once it is long enough that two slips still leave it unmistakable. Below
 *  four letters nothing is forgiven, because at that length almost every word
 *  is one edit from another one. */
function tolerance(token: string): number {
  if (token.length >= 8) return 2;
  if (token.length >= 4) return 1;
  return 0;
}

/** Counts a swap of two neighbours as ONE edit, not two: "spruots" is the way
 *  a fast typist misses "sprouts", and plain Levenshtein prices that the same
 *  as two unrelated mistakes. */
function withinEdits(a: string, b: string, max: number): boolean {
  if (max <= 0) return a === b;
  if (Math.abs(a.length - b.length) > max) return false;
  let twoBack: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, twoBack[j - 2] + 1);
      }
      row.push(v);
      if (v < best) best = v;
    }
    if (best > max) return false;
    twoBack = prev;
    prev = row;
  }
  return prev[b.length] <= max;
}

/* How well one query word sits on one field. Lower is better; -1 is no. */
const TIER_EXACT = 0;
const TIER_PREFIX = 1;
const TIER_OVERTYPED = 2;
const TIER_INSIDE = 3;
const TIER_TYPO = 4;
const NO_MATCH = -1;

function tokenTier(token: string, words: string[]): number {
  const t = canon(token);
  let best = NO_MATCH;
  for (const raw of words) {
    const w = canon(raw);
    let tier = NO_MATCH;
    if (w === t) tier = TIER_EXACT;
    else if (w.startsWith(t)) tier = TIER_PREFIX;
    else if (t.startsWith(w) && t.length - w.length <= 2) tier = TIER_OVERTYPED;
    else if (t.length >= 3 && w.includes(t)) tier = TIER_INSIDE;
    else if (withinEdits(t, w, tolerance(t))) tier = TIER_TYPO;
    if (tier !== NO_MATCH && (best === NO_MATCH || tier < best)) best = tier;
    if (best === TIER_EXACT) return best;
  }
  return best;
}

export type MatchableFields = {
  /** What the record is called. Only this field can reach the top ranks. */
  name: string;
  /** Everything else that identifies the same record: city, state, area,
   *  address, a contact's title, the account they belong to. */
  also?: (string | null | undefined)[];
};

/**
 * Lower is better, null is no match. The number is only ever compared against
 * other results of the same query, so its scale means nothing on its own.
 */
export function matchScore(query: string, fields: MatchableFields): number | null {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return null;

  const nameNorm = normalizeSearch(fields.name || "");
  const nameWords = nameNorm ? nameNorm.split(" ") : [];
  const extraWords: string[] = [];
  for (const f of fields.also ?? []) {
    const n = normalizeSearch(f || "");
    if (n) extraWords.push(...n.split(" "));
  }
  if (nameWords.length === 0 && extraWords.length === 0) return null;

  const whole = tokens.join(" ");
  let tierSum = 0;
  let worstAnywhere = TIER_EXACT;
  let worstInName = TIER_EXACT;
  let extrasOnly = 0;
  let matchedAny = false;

  for (const token of tokens) {
    const inName = tokenTier(token, nameWords);
    const inExtra = tokenTier(token, extraWords);
    const best = inName === NO_MATCH ? inExtra : inExtra === NO_MATCH ? inName : Math.min(inName, inExtra);
    if (best === NO_MATCH) {
      // An optional word missing from the record is not a refusal. A real one
      // is: forgiving is not the same as matching everything.
      if (OPTIONAL.has(token)) continue;
      return null;
    }
    matchedAny = true;
    tierSum += best;
    if (best > worstAnywhere) worstAnywhere = best;
    if (inName === NO_MATCH || inName > best) extrasOnly++;
    const nameSide = inName === NO_MATCH ? TIER_TYPO + 1 : inName;
    if (nameSide > worstInName) worstInName = nameSide;
  }
  if (!matchedAny) return null;

  let level: number;
  if (nameNorm === whole) level = 0;
  else if (nameNorm.startsWith(whole)) level = 1;
  else if (worstInName <= TIER_PREFIX) level = 2;
  else if (worstAnywhere <= TIER_PREFIX) level = 3;
  else if (worstAnywhere <= TIER_INSIDE) level = 4;
  else level = 5;

  return level * 1e6 + tierSum * 1e4 + extrasOnly * 1e2 + Math.min(nameNorm.length, 99);
}

export function matches(query: string, fields: MatchableFields): boolean {
  return matchScore(query, fields) !== null;
}

/** Ranked hits, best first, ties broken by name so the order never wobbles
 *  between keystrokes. */
export function rankMatches<T>(
  query: string,
  items: readonly T[],
  fieldsOf: (item: T) => MatchableFields,
  limit?: number,
): T[] {
  const hits: { item: T; score: number; name: string }[] = [];
  for (const item of items) {
    const fields = fieldsOf(item);
    const score = matchScore(query, fields);
    if (score === null) continue;
    hits.push({ item, score, name: fields.name || "" });
  }
  hits.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  const ordered = hits.map((h) => h.item);
  return limit === undefined ? ordered : ordered.slice(0, limit);
}

/**
 * The words worth handing to a search that can only take one substring, most
 * selective first. Long words are more selective than short ones, and a word
 * the record is unlikely to carry at all (a city that lives in another column,
 * a stray "the") is exactly the one that would return nothing.
 */
export function selectiveTokens(query: string, max = 2): string[] {
  return searchTokens(query)
    .filter((t) => !OPTIONAL.has(t) && t.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, max);
}
