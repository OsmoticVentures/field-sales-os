/**
 * One matcher for every search box on this screen. Ported unchanged from the
 * NutriBiotic OS (portfolio/src/app/nutribiotic/lib/search-match.ts). Every
 * word of the query has to land somewhere on the record, rather than the
 * whole sentence having to land in one field. Pure, no I/O.
 */

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

const OPTIONAL = new Set(["the", "a", "an", "of", "and", "at", "in", "on", "for", "dba", "inc", "llc", "ltd", "corp"]);

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

function tolerance(token: string): number {
  if (token.length >= 8) return 2;
  if (token.length >= 4) return 1;
  return 0;
}

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
  name: string;
  also?: (string | null | undefined)[];
};

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

/** The most selective words of a query, longest first, for a backend that
 *  takes one token at a time (HubSpot's CONTAINS_TOKEN). The full query
 *  still decides the order through matchScore once results are back. */
export function selectiveTokens(query: string, max = 2): string[] {
  return searchTokens(query)
    .filter((t) => !OPTIONAL.has(t) && t.length >= 3)
    .sort((a, b) => b.length - a.length)
    .slice(0, max);
}
