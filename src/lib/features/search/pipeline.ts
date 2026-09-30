/**
 * The Search screen's pipeline, ported from
 * bridges/nutribiotic/places_search_ingest.py (and the helpers it imported
 * from geocode.py and lib/prospect_land.py) so it runs on Vercel instead of
 * waiting for Juan's Mac. Same three stages, same filters in the same order,
 * same triage weights, same drop-reason strings, same summary shape: the
 * Python file's docstrings are the long-form rationale for every rule here.
 *
 *   search   Places -> filters -> triage. Reads Supabase, writes nothing.
 *   enrich   reads the picked candidates' own websites. Writes nothing.
 *   land     the only stage that writes: nb_accounts + nb_sdr_schedule, and
 *            only when the request carries write:true.
 *
 * NOTHING HERE TOUCHES HUBSPOT. Landed rows carry hubspot_sync_eligible=false
 * and earn a portal record the day a real touchpoint is logged.
 */
import "server-only";
import { decodeHTML as decodeEntities } from "entities";
import { AMBIGUOUS_CITIES, CATALOG_TERMS, TERRITORY_AREAS, type TerritoryArea } from "./config.generated";
import { insertRows, isConfigured, loadLocalAccounts, randId, type LocalAccount } from "./dal";
import { PageText } from "./html";
import { matchAccount, normPhone, pyFloat, pyRound } from "./match";
import { extractJsonLd, fetchWebPage, isScriptShell } from "../../shared/web-page";

type Log = (msg: string) => void;
type Json = Record<string, unknown>;
type Place = Json & {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  websiteUri?: string;
  businessStatus?: string;
  types?: string[];
  primaryType?: string;
  rating?: number;
  userRatingCount?: number;
  regularOpeningHours?: {
    weekdayDescriptions?: string[];
    periods?: { open?: { day?: number; hour?: number; minute?: number }; close?: { day?: number; hour?: number; minute?: number } }[];
  };
  photos?: unknown[];
};
type Rect = { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } };
type Candidate = Json;

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const SOURCE = "nb_places_search";
const OWNER_ID = "36242368";
const OWNER_NAME = "Juan Arenas Martin";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.nationalPhoneNumber",
  "places.websiteUri",
  "places.businessStatus",
  "places.types",
  "places.primaryType",
  "places.rating",
  "places.userRatingCount",
  "places.regularOpeningHours",
  "nextPageToken",
].join(",");
const PHOTO_FIELD = "places.photos";

const MAX_PAGES = 3;
const PAGE_SIZE = 20;

/** category -> Google's own type filter. Longest key wins. Every value was
 *  verified live against searchText; an unmapped category sends nothing. */
const CATEGORY_TYPES: Record<string, string> = {
  "medical spa": "spa",
  "med spa": "spa",
  medspa: "spa",
  "day spa": "spa",
  spa: "spa",
  wellness: "wellness_center",
  massage: "massage",
  sauna: "sauna",
  "skin care": "skin_care_clinic",
  skincare: "skin_care_clinic",
  esthetician: "skin_care_clinic",
  "beauty salon": "beauty_salon",
  salon: "beauty_salon",
  barber: "barber_shop",
  chiropract: "chiropractor",
  "physical therapy": "physiotherapist",
  physiotherap: "physiotherapist",
  yoga: "yoga_studio",
  pilates: "gym",
  crossfit: "gym",
  gym: "gym",
  fitness: "fitness_center",
  "sports club": "sports_club",
  dentist: "dental_clinic",
  dental: "dental_clinic",
  pharmacy: "pharmacy",
  drugstore: "drugstore",
  veterinar: "veterinary_care",
  physician: "doctor",
  doctor: "doctor",
  clinic: "doctor",
  "health food": "grocery_store",
  grocery: "grocery_store",
  supermarket: "supermarket",
  juice: "juice_shop",
  smoothie: "juice_shop",
};

// Python's sorted(..., key=len, reverse=True) is stable, so ties keep dict order.
const CATEGORY_PHRASES = Object.keys(CATEGORY_TYPES)
  .map((k, i) => [k, i] as const)
  .sort((a, b) => b[0].length - a[0].length || a[1] - b[1])
  .map(([k]) => k);

export function includedTypeFor(category: string): string | null {
  const c = (category || "").toLowerCase();
  for (const phrase of CATEGORY_PHRASES) if (c.includes(phrase)) return CATEGORY_TYPES[phrase];
  return null;
}

function categoryExcluded(p: Place, excludes: string[]): string | null {
  if (!excludes.length) return null;
  const typesBlob = (p.types ?? []).map((t) => t.replaceAll("_", " ")).join(" ");
  const primary = (p.primaryType ?? "").replaceAll("_", " ");
  const name = p.displayName?.text ?? "";
  const haystack = `${typesBlob} ${primary} ${name}`.toLowerCase();
  for (const phrase of excludes) {
    const needle = (phrase || "").trim().toLowerCase().replaceAll("_", " ");
    if (needle && haystack.includes(needle)) return phrase;
  }
  return null;
}

function chainExcluded(p: Place, chains: string[]): string | null {
  if (!chains.length) return null;
  const name = (p.displayName?.text ?? "").toLowerCase();
  for (const chain of chains) {
    const needle = (chain || "").trim().toLowerCase();
    if (needle && name.includes(needle)) return chain;
  }
  return null;
}

const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const mod = (a: number, n: number) => ((a % n) + n) % n;

function hoursTodayLine(p: Place, day: number): string | null {
  const lines = p.regularOpeningHours?.weekdayDescriptions ?? [];
  if (lines.length !== 7) return null;
  return lines[mod(day - 1, 7)];
}

const WEEK_MIN = 7 * 1440;

function openAt(p: Place, day: number, minuteOfDay: number): boolean | null {
  const periods = p.regularOpeningHours?.periods;
  if (periods == null) return null;
  const target = day * 1440 + minuteOfDay;
  for (const period of periods) {
    const o = period.open ?? {};
    if (o.day == null) continue;
    const oAbs = Number(o.day) * 1440 + Number(o.hour || 0) * 60 + Number(o.minute || 0);
    const c = period.close;
    let cAbs: number;
    if (c == null) {
      cAbs = oAbs + WEEK_MIN;
    } else {
      const cDay = c.day != null ? c.day : o.day;
      cAbs = Number(cDay) * 1440 + Number(c.hour || 0) * 60 + Number(c.minute || 0);
      if (cAbs <= oAbs) cAbs += WEEK_MIN;
    }
    if ((oAbs <= target && target < cAbs) || (oAbs <= target + WEEK_MIN && target + WEEK_MIN < cAbs)) return true;
  }
  return false;
}

const AREA_MARGIN_DEG = 0.05;
const EARTH_M = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const p1 = rad(lat1);
  const p2 = rad(lat2);
  const dp = p2 - p1;
  const dl = rad(lng2 - lng1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(a));
}

const nowIso = () => new Date().toISOString();
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1. searcher
// ---------------------------------------------------------------------------

export class PlacesError extends Error {}

function apiKey(): string {
  return process.env.NB_PLACES_API_KEY ?? "";
}

async function placesCall(body: Json, log: Log, fieldMask: string, retries = 5, timeoutMs = 30_000): Promise<Json> {
  let delay = 2;
  let last = "";
  for (let attempt = 0; attempt < retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(PLACES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey(), "X-Goog-FieldMask": fieldMask },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (e) {
      last = String((e as Error)?.message ?? e);
      log(`    network: ${last.slice(0, 120)}, retry in ${delay.toFixed(0)}s`);
      await sleepMs(delay * 1000);
      delay = Math.min(delay * 2, 60);
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      return JSON.parse(text || "{}") as Json;
    }
    last = `${res.status} ${(await res.text()).slice(0, 400)}`;
    if (res.status === 429) {
      const wait = Number.parseFloat(res.headers.get("Retry-After") ?? "") || delay;
      log(`    429 from Places, waiting ${wait.toFixed(0)}s. ${last.slice(0, 160)}`);
      await sleepMs(wait * 1000);
      delay = Math.min(delay * 2, 60);
      continue;
    }
    if (res.status >= 500 && res.status < 600) {
      log(`    ${res.status} from Places, retry in ${delay.toFixed(0)}s`);
      await sleepMs(delay * 1000);
      delay = Math.min(delay * 2, 60);
      continue;
    }
    throw new PlacesError(last);
  }
  throw new PlacesError(`searchText failed after ${retries} attempts: ${last}`);
}

function rectFromAnchors(anchors: [number, number][]): Rect {
  const lats = anchors.map((a) => Number(a[0]));
  const lngs = anchors.map((a) => Number(a[1]));
  return {
    low: { latitude: Math.min(...lats) - AREA_MARGIN_DEG, longitude: Math.min(...lngs) - AREA_MARGIN_DEG },
    high: { latitude: Math.max(...lats) + AREA_MARGIN_DEG, longitude: Math.max(...lngs) + AREA_MARGIN_DEG },
  };
}

function rectFromCircle(lat: number, lng: number, radiusM: number): Rect {
  const dlat = radiusM / 111_320.0;
  const dlng = radiusM / (111_320.0 * Math.max(Math.cos(rad(lat)), 0.01));
  return { low: { latitude: lat - dlat, longitude: lng - dlng }, high: { latitude: lat + dlat, longitude: lng + dlng } };
}

function rectFromPolygon(vertices: [number, number][]): Rect {
  const lats = vertices.map((v) => v[0]);
  const lngs = vertices.map((v) => v[1]);
  return {
    low: { latitude: Math.min(...lats), longitude: Math.min(...lngs) },
    high: { latitude: Math.max(...lats), longitude: Math.max(...lngs) },
  };
}

/** Even-odd ray cast on the pins as drawn; the last pin wraps to the first. */
function pointInPolygon(lat: number, lng: number, vertices: [number, number][]): boolean {
  let inside = false;
  const n = vertices.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const [yi, xi] = vertices[i];
    const [yj, xj] = vertices[j];
    if (yi > lat !== yj > lat) {
      const xAt = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (lng < xAt) inside = !inside;
    }
    j = i;
  }
  return inside;
}

function parsePolygon(raw: unknown): [number, number][] {
  const pts: [number, number][] = [];
  if (typeof raw === "string") {
    for (const chunk of raw.replaceAll(";", " ").split(/\s+/).filter(Boolean)) {
      const parts = chunk.split(",");
      if (parts.length !== 2) throw new PlacesError(`polygon vertex '${chunk}' is not lat,lng`);
      pts.push([Number.parseFloat(parts[0]), Number.parseFloat(parts[1])]);
    }
  } else {
    for (const v of (raw as unknown[]) ?? []) {
      let lat: unknown;
      let lng: unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        lat = (v as Json).lat;
        lng = (v as Json).lng;
      } else {
        const arr = v as unknown[];
        if (!Array.isArray(arr) || arr.length !== 2) throw new PlacesError(`polygon vertex ${JSON.stringify(v)} is not [lat, lng]`);
        [lat, lng] = arr;
      }
      if (lat == null || lng == null) throw new PlacesError(`polygon vertex ${JSON.stringify(v)} has no coordinates`);
      pts.push([Number(lat), Number(lng)]);
    }
  }
  if (pts.length < 3) throw new PlacesError(`a polygon needs at least 3 pins; got ${pts.length}. Nothing was searched.`);
  for (const [lat, lng] of pts) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new PlacesError(`polygon vertex ${lat},${lng} is not a coordinate`);
    }
  }
  return pts;
}

// Page 0 of a query, kept for the life of this server instance (the Mac kept
// it in a JSON file). A page token is single-use, so only page 0 is cached.
const CACHE_MAX = 300;
const pageCache = new Map<string, Json>();
function cachePut(key: string, body: Json) {
  if (pageCache.has(key)) pageCache.delete(key);
  pageCache.set(key, body);
  while (pageCache.size > CACHE_MAX) pageCache.delete(pageCache.keys().next().value as string);
}

async function searchPages(
  textQuery: string,
  restriction: Rect | null,
  cacheKey: string,
  sleep: number,
  log: Log,
  includedType: string | null,
  strictType: boolean,
  fieldMask: string,
): Promise<[Place[], number, boolean]> {
  const out: Place[] = [];
  let calls = 0;
  let token: string | undefined;
  let servedFromCache = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const key = `${cacheKey}|p${page}`;
    let body: Json;
    if (page === 0 && pageCache.has(key)) {
      body = pageCache.get(key)!;
      servedFromCache = true;
    } else {
      const req: Json = { textQuery, pageSize: PAGE_SIZE, languageCode: "en" };
      if (includedType) {
        req.includedType = includedType;
        req.strictTypeFiltering = Boolean(strictType);
      }
      if (restriction) req.locationRestriction = { rectangle: restriction };
      if (token) req.pageToken = token;
      body = await placesCall(req, log, fieldMask);
      calls += 1;
      if (page === 0) cachePut(key, body);
      await sleepMs(sleep * 1000);
    }
    out.push(...((body.places as Place[] | undefined) ?? []));
    token = body.nextPageToken as string | undefined;
    if (!token || servedFromCache) break;
  }
  return [out, calls, out.length >= MAX_PAGES * PAGE_SIZE];
}

const MAX_SPLIT_DEPTH = 2;
const MAX_SPLIT_CALLS = 45;
const DEEP_SPLIT_DEPTH = 3;
const DEEP_SPLIT_CALLS = 150;

function splitRect(rect: Rect): Rect[] {
  const lo = rect.low;
  const hi = rect.high;
  const midLat = (lo.latitude + hi.latitude) / 2;
  const midLng = (lo.longitude + hi.longitude) / 2;
  return [
    { low: { latitude: lo.latitude, longitude: lo.longitude }, high: { latitude: midLat, longitude: midLng } },
    { low: { latitude: lo.latitude, longitude: midLng }, high: { latitude: midLat, longitude: hi.longitude } },
    { low: { latitude: midLat, longitude: lo.longitude }, high: { latitude: hi.latitude, longitude: midLng } },
    { low: { latitude: midLat, longitude: midLng }, high: { latitude: hi.latitude, longitude: hi.longitude } },
  ];
}

/** One query, auto-split into quadrants whenever it hits Google's 60 cap. */
async function searchRect(
  textQuery: string,
  rect: Rect | null,
  baseKey: string,
  sleep: number,
  log: Log,
  includedType: string | null,
  strictType: boolean,
  fieldMask: string,
  depth: number,
  callsLeft: { n: number },
  maxDepth: number,
): Promise<[Map<string, Place>, number, boolean]> {
  const key = `${baseKey}|r=${rect ? JSON.stringify(rect) : "none"}`;
  const [places, made, ceiling] = await searchPages(textQuery, rect, key, sleep, log, includedType, strictType, fieldMask);
  callsLeft.n -= made;
  const out = new Map<string, Place>();
  for (const p of places) if (p.id) out.set(p.id, p);
  if (!(ceiling && rect && depth < maxDepth && callsLeft.n > 0)) return [out, made, ceiling];

  log(`    hit the 60-result ceiling at depth ${depth}, splitting into 4 and re-querying each quadrant`);
  let calls = made;
  let stillSaturated = false;
  for (const sub of splitRect(rect)) {
    if (callsLeft.n <= 0) {
      stillSaturated = true;
      break;
    }
    const [subOut, subCalls, subCeiling] = await searchRect(
      textQuery, sub, baseKey, sleep, log, includedType, strictType, fieldMask, depth + 1, callsLeft, maxDepth,
    );
    for (const [id, p] of subOut) out.set(id, p);
    calls += subCalls;
    stillSaturated = stillSaturated || subCeiling;
  }
  return [out, calls, stillSaturated];
}

const MILES_PER_DEG_LAT = 69.0;

function sqMileCell(lat: number, lng: number): string {
  const latDeg = 1.0 / MILES_PER_DEG_LAT;
  const lngDeg = 1.0 / (MILES_PER_DEG_LAT * Math.max(Math.cos(rad(lat)), 0.01));
  return `${Math.floor(lat / latDeg)},${Math.floor(lng / lngDeg)}`;
}

function component(place: Place, kind: string): string {
  for (const c of place.addressComponents ?? []) {
    if ((c.types ?? []).includes(kind)) return c.longText || c.shortText || "";
  }
  return "";
}

async function resolveNear(name: string, log: Log): Promise<[number, number, string]> {
  const q = /,\s*(CA|California)\b/i.test(name) ? name : `${name}, CA`;
  let place: Place | undefined;
  try {
    const res = await fetch(PLACES_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey(), "X-Goog-FieldMask": "places.displayName,places.location" },
      body: JSON.stringify({ textQuery: q, maxResultCount: 3, languageCode: "en" }),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Places HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    place = (((await res.json()) as Json).places as Place[] | undefined)?.[0];
  } catch (e) {
    throw new PlacesError(`could not resolve --near '${name}': ${(e as Error).message}`);
  }
  if (!place) throw new PlacesError(`Places has no result for --near '${name}'. Give --center lat,lng instead.`);
  const loc = place.location ?? {};
  if (loc.latitude == null || loc.longitude == null) throw new PlacesError(`--near '${name}' resolved to a place with no coordinates.`);
  const label = place.displayName?.text || name;
  log(`  --near '${name}' -> ${label} @ ${loc.latitude.toFixed(5)},${loc.longitude.toFixed(5)}`);
  return [loc.latitude, loc.longitude, label];
}

// ---------------------------------------------------------------------------
// territory, address parsing, the book (lib/prospect_land.py)
// ---------------------------------------------------------------------------

function normCity(raw: string | null | undefined): string {
  return (raw || "").trim().toLowerCase().replace(/[^a-z ]/g, "").trim();
}

type Territory = { cityToArea: Map<string, string>; ambiguous: Set<string>; anchors: [number, number, string][] };

function loadTerritory(): Territory {
  const cityToArea = new Map<string, string>();
  const anchors: [number, number, string][] = [];
  for (const area of TERRITORY_AREAS) {
    for (const c of area.cities) cityToArea.set(normCity(c), area.id);
    for (const pt of area.anchors) anchors.push([pt[0], pt[1], area.id]);
  }
  return { cityToArea, ambiguous: new Set(AMBIGUOUS_CITIES.map(normCity)), anchors };
}

function areaFor(city: string, lat: number | undefined, lng: number | undefined, t: Territory): string | null {
  const key = normCity(city);
  if (!key) return null;
  if (t.ambiguous.has(key)) {
    if (lat == null || lng == null || !t.anchors.length) return null;
    let best = t.anchors[0];
    let bestD = (best[0] - lat) ** 2 + (best[1] - lng) ** 2;
    for (const a of t.anchors) {
      const d = (a[0] - lat) ** 2 + (a[1] - lng) ** 2;
      if (d < bestD) {
        best = a;
        bestD = d;
      }
    }
    return best[2];
  }
  return t.cityToArea.get(key) ?? null;
}

function splitStreet(formatted: string, city: string): string | null {
  if (!formatted) return null;
  const head = formatted.split(",")[0].trim();
  if (!head || normCity(head) === normCity(city)) return null;
  return head || null;
}

function parsePostal(formatted: string): string | null {
  const hits = [...(formatted || "").matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].map((m) => m[1]);
  return hits.length ? hits[hits.length - 1] : null;
}

class Book {
  rows: LocalAccount[];
  private bySource = new Map<string, LocalAccount>();
  private byPlace = new Map<string, LocalAccount[]>();
  private byPhone = new Map<string, LocalAccount[]>();

  constructor(rows: LocalAccount[]) {
    this.rows = rows;
    for (const r of rows) {
      if (r.source_external_id) this.bySource.set(`${r.source}|${String(r.source_external_id)}`, r);
      if (r.places_id) {
        const l = this.byPlace.get(r.places_id) ?? [];
        l.push(r);
        this.byPlace.set(r.places_id, l);
      }
      const ph = normPhone(r.phone);
      if (ph) {
        const l = this.byPhone.get(ph) ?? [];
        l.push(r);
        this.byPhone.set(ph, l);
      }
    }
  }

  find(cand: Json, source: string, extId: unknown): [Json | null, string] {
    if (extId) {
      const hit = this.bySource.get(`${source}|${String(extId)}`);
      if (hit) return [hit, "source id"];
    }
    const pid = String(cand.places_id ?? "").trim();
    if (pid && this.byPlace.get(pid)?.length) return [this.byPlace.get(pid)![0], "place id"];
    const ph = normPhone(cand.phone as string | null);
    if (ph && this.byPhone.get(ph)?.length) return [this.byPhone.get(ph)![0], "phone"];
    const m = matchAccount(
      {
        name: cand.name as string | null,
        phone: cand.phone as string | null,
        street: cand.street as string | null,
        city: cand.city as string | null,
        postal: cand.postal as string | null,
      },
      this.rows,
    );
    if ((m.decision_hint === "merge" || m.decision_hint === "review") && m.account_id) {
      return [{ id: m.account_id, name: m.account_name || "" }, `matcher: ${m.decision_hint} (${pyFloat(m.score)})`];
    }
    return [null, ""];
  }
}

// ---------------------------------------------------------------------------
// 2. cheap triage
// ---------------------------------------------------------------------------

function triageScore(place: Place): [number, Json] {
  const parts: Json = {};
  let s = 0;
  if ((place.nationalPhoneNumber || "").trim()) {
    parts.phone = 20;
    s += 20;
  }
  const n = place.userRatingCount || 0;
  if (n) {
    const norm = Math.max(0, Math.min(100, 20 * Math.log10(Math.max(n, 1)) + 20));
    const v = pyRound((norm / 100) * 45, 1);
    parts.reviews = v;
    s += v;
  }
  const r = place.rating;
  if (r != null && n >= 5) {
    const v = pyRound(Math.max(0, Math.min(1, (Number(r) - 3.5) / 1.5)) * 35, 1);
    parts.rating = v;
    s += v;
  }
  return [pyRound(s, 1), parts];
}

// ---------------------------------------------------------------------------
// 3. deep enrichment, from the site's own words
// ---------------------------------------------------------------------------

const MAX_HTML_BYTES = 800_000;
const FETCH_TIMEOUT_MS = 15_000;

/** [html, finalUrl] or [null, why]. The fetching itself (browser headers,
 *  retry, host twins, charset, byte cap, challenge pages) is
 *  lib/shared/web-page.ts, shared with Find Contacts and SDR's enrich. */
async function fetchPage(url: string, deadline?: number): Promise<[string | null, string]> {
  const r = await fetchWebPage(url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_HTML_BYTES, deadline });
  return r.ok ? [r.page.html, r.page.finalUrl] : [null, r.reason];
}

const ABOUT_HINT = /about|our[-_ ]?story|our[-_ ]?team|who[-_ ]?we[-_ ]?are|meet[-_ ]?the|staff|providers?|contact/i;

function pySplitWs(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

function trimSentences(s: string, limit = 400): string {
  const t = pySplitWs(s).join(" ");
  const unescaped = decodeEntities(t);
  const cps = Array.from(unescaped);
  if (cps.length <= limit) return unescaped;
  const cut = cps.slice(0, limit).join("");
  const parts = cut.split(/(?<=[.!?])\s/);
  if (parts.length > 1) return parts.slice(0, -1).join(" ").trim();
  const sp = cut.lastIndexOf(" ");
  return (sp === -1 ? cut : cut.slice(0, sp)).trim() + "...";
}

function firstSelfDescription(page: PageText): [string, string] | null {
  if (page.metaDesc && page.metaDesc.trim().length >= 40) return [trimSentences(page.metaDesc.trim()), "meta description"];
  for (const line of page.text().split("\n")) {
    const ln = line.trim();
    if (Array.from(ln).length >= 80 && ln.split(" ").length - 1 >= 12 && !ln.toLowerCase().startsWith("copyright")) {
      return [trimSentences(ln), "first paragraph"];
    }
  }
  return null;
}

const FIT_TERMS: Record<string, string[]> = {
  facials: ["facial", "facials"],
  microblading: ["microblading", "micro-blading", "microshading"],
  PRP: ["prp", "platelet-rich plasma", "platelet rich plasma"],
  "sports nutrition": ["sports nutrition", "pre-workout", "preworkout", "protein powder", "athletic performance", "recovery drink"],
  supplements: ["supplement", "supplements"],
  vitamin: ["vitamin", "vitamins"],
  skincare: ["skincare", "skin care"],
  "vegan protein": ["vegan protein", "plant-based protein", "plant protein"],
  protein: ["protein"],
  nutraceuticals: ["nutraceutical", "nutraceuticals"],
};

// A named person, mined out of prose (prospect_land.PERSON_PATTERNS). The role
// words are case-insensitive and the name is not; JS has no scoped (?i:...),
// so the role words are spelled out case-insensitively instead.
const ci = (words: string) => words.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
const ROLE = `(?:${["owner", "founder", "co-?founder", "proprietor", "medical director", "practice manager", "md"].map(ci).join("|")})`;
const WORD = "[A-Z][a-z']+(?:-[A-Z][a-z']+)?";
const NAME = `(?:Dr\\.?\\s+)?(${WORD}(?:\\s+${WORD}){1,2})`;
const PERSON_PATTERNS: [string, RegExp][] = [
  ["owner_is", new RegExp(`\\b${ROLE}(?:\\s+(?:${ci("and")}|&)\\s+\\w+)?\\s*(?:${ci("is")}|:)\\s+${NAME}`)],
  ["founded_by", new RegExp(`\\b(?:${["founded", "owned", "opened", "led", "run"].map(ci).join("|")})\\s+(?:${ci("by")})\\s+${NAME}`)],
  ["name_comma_role", new RegExp(`\\b${NAME},\\s+(?:${ci("the")}\\s+)?${ROLE}\\b`)],
  ["greeting", new RegExp(`^\\s*(?:${["hi", "hello", "dear"].map(ci).join("|")})\\s+(?:Dr\\.?\\s+)?(${WORD}(?:\\s+${WORD})?)\\s*[,!]`, "m")],
];
const NOT_A_PERSON = new Set([
  "there", "team", "owner", "friend", "folks", "everyone", "sir", "madam", "first name", "name", "customer", "client",
  "doctor", "manager", "our team", "the team", "meet the", "welcome to", "about us",
]);

function personInText(text: string): [string, string] | null {
  if (typeof text !== "string" || !text.trim()) return null;
  for (const [label, pat] of PERSON_PATTERNS) {
    const m = pat.exec(text);
    if (!m) continue;
    const name = pySplitWs(m[1]).join(" ");
    if (NOT_A_PERSON.has(name.toLowerCase()) || name.length < 4) continue;
    return [name, label];
  }
  return null;
}

function hostOf(u: string): string | null {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

async function enrichFromSite(url: string, maxPages = 4, deadline?: number): Promise<Json> {
  const out: Json & { pages_read: string[]; failures: string[] } = { pages_read: [], failures: [] };
  const start = url.startsWith("http://") || url.startsWith("https://") ? url : "https://" + url;
  const [homeHtml, final] = await fetchPage(start, deadline);
  if (homeHtml === null) {
    out.failures.push(`${start}: ${final}`);
    return out;
  }
  const home = new PageText(homeHtml);
  out.pages_read.push(final);
  if (isScriptShell(homeHtml)) out.failures.push(`${final}: the page builds its text in the browser, little of it could be read`);

  const desc = firstSelfDescription(home);
  if (desc) out.about = { text: desc[0], url: final, basis: desc[1] };
  else {
    // A page that says nothing in its HTML often still describes itself in
    // its structured data, verbatim.
    const ld = extractJsonLd(homeHtml).description;
    if (ld) out.about = { text: trimSentences(ld), url: final, basis: "structured data description" };
  }

  const host = hostOf(final);
  const texts: [string, string][] = [[final, home.text()]];
  const seen = new Set([final]);
  const next: string[] = [];
  for (const [href, anchor] of home.links) {
    if (next.length >= maxPages - 1) break;
    if (!ABOUT_HINT.test(anchor || "") && !ABOUT_HINT.test(href || "")) continue;
    let nxt: string;
    try {
      nxt = new URL(href, final).href.split("#")[0];
    } catch {
      continue;
    }
    const scheme = nxt.split(":")[0].toLowerCase();
    if ((scheme !== "http" && scheme !== "https") || hostOf(nxt) !== host || seen.has(nxt)) continue;
    seen.add(nxt);
    next.push(nxt);
  }
  // All at once, kept in link order, so a site costs its slowest page, not
  // the sum of its pages.
  const subs = await Promise.all(next.map((n) => fetchPage(n, deadline)));
  subs.forEach(([subHtml, subFinal], i) => {
    if (subHtml === null) {
      out.failures.push(`${next[i]}: ${subFinal}`);
      return;
    }
    out.pages_read.push(subFinal);
    texts.push([subFinal, new PageText(subHtml).text()]);
  });

  const ordered = texts.map((t, i) => [t, i] as const).sort((a, b) => {
    const ka = ABOUT_HINT.test(a[0][0]) ? 0 : 1;
    const kb = ABOUT_HINT.test(b[0][0]) ? 0 : 1;
    return ka - kb || a[1] - b[1];
  });
  for (const [[pageUrl, text]] of ordered) {
    const found = personInText(text);
    if (found) {
      out.person = { value: found[0], confidence: "low", found_by: `website ${pageUrl} regex:${found[1]}` };
      break;
    }
  }

  const blob = texts.map(([, t]) => t).join("\n").toLowerCase();
  const tags: Record<string, string[]> = {};
  for (const [tag, phrases] of Object.entries(FIT_TERMS)) {
    const hit = phrases.filter((ph) => blob.includes(ph));
    if (hit.length) tags[tag] = hit;
  }
  const cat = CATALOG_TERMS.filter((t) => blob.includes(t));
  if (Object.keys(tags).length || cat.length) out.fit = { tags, catalog_terms: cat, urls: [...out.pages_read] };
  return out;
}

/** A bare root is stored as a bare host; any URL with a path is kept whole. */
function storeWebsite(uri: string | null | undefined): string | null {
  const u = (uri || "").trim();
  if (!u) return null;
  const full = u.includes("://") ? u : "https://" + u;
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/.exec(full);
  if (!m) return u;
  const path = (m[2] || "").replace(/^\/+|\/+$/g, "");
  if (!path && !m[3]) return m[1].toLowerCase();
  return u;
}

// ---------------------------------------------------------------------------
// the three stages
// ---------------------------------------------------------------------------

function blankCandidateFields(): Json {
  return {
    enriched: false,
    about: null,
    about_url: null,
    about_basis: null,
    decision_maker_candidate: null,
    decision_maker_found_by: null,
    fit_tags: [],
    fit_terms_by_tag: {},
    catalog_terms: [],
    fit_urls: [],
    pages_read: [],
    site_failures: [],
  };
}

type Summary = Json & { ok: boolean; stage: string; stages: Json; candidates: Candidate[]; errors: string[] };

function baseSummary(stage: string): Summary {
  return { ok: false, stage, started_at: nowIso(), stages: {}, candidates: [], hubspot_writes: 0, errors: [] };
}

/** Today's weekday (0=Sunday) and date in the territory's own time zone. */
function laParts(): { weekday: number; ymd: string } {
  const now = new Date();
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" }).format(now);
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return { weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd), ymd };
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function counter(): { add: (k: string, n?: number) => void; set: (k: string, n: number) => void; obj: () => Record<string, number> } {
  const m = new Map<string, number>();
  return {
    add: (k, n = 1) => m.set(k, (m.get(k) ?? 0) + n),
    set: (k, n) => m.set(k, n),
    obj: () => Object.fromEntries(m),
  };
}

const pyNum = (x: number) => String(x); // Python's :g for the 0-100 values these take

export type SearchOpts = {
  polygon?: unknown;
  center?: [number, number] | null;
  near?: string | null;
  areas?: string[] | null;
  radius_m?: number;
  by_city?: boolean;
  included_type?: string | null;
  strict_type?: boolean;
  min_review_count?: number;
  require_phone?: boolean;
  require_website?: boolean;
  min_rating?: number;
  min_triage_score?: number;
  exclude_categories?: string[] | null;
  chain_exclude?: boolean;
  chain_names?: string[] | null;
  min_photos?: number;
  max_per_sq_mile?: number;
  open_day?: number | null;
  open_time?: string | null;
  deep?: boolean;
  max_candidates?: number;
  sleep?: number;
};

export async function search(category: string, o: SearchOpts, log: Log): Promise<Summary> {
  const includedType = o.included_type === undefined ? "auto" : o.included_type;
  const strictType = o.strict_type ?? true;
  const minReviewCount = o.min_review_count ?? 30;
  const requirePhone = o.require_phone ?? true;
  const requireWebsite = o.require_website ?? true;
  const minRating = o.min_rating ?? 4.0;
  const minTriage = o.min_triage_score ?? 45.0;
  const maxPerSqMile = o.max_per_sq_mile ?? 0;
  const maxCandidates = o.max_candidates ?? 0;
  const sleep = o.sleep ?? 0.3;
  const radiusM = o.radius_m ?? 2500;

  const itype = includedType === "auto" ? includedTypeFor(category) : includedType || null;
  const excludes = (o.exclude_categories ?? []).filter((c) => (c || "").trim());
  const chains = o.chain_exclude ? (o.chain_names ?? []).filter((c) => (c || "").trim()) : [];
  const minPhotos = Math.max(0, Math.trunc(o.min_photos || 0));
  const fieldMask = FIELD_MASK + (minPhotos ? "," + PHOTO_FIELD : "");
  let openMinute: number | null = null;
  if (o.open_day != null && o.open_time) {
    const parts = o.open_time.split(":");
    if (parts.length === 2 && parts.every((x) => /^\s*[+-]?\d+\s*$/.test(x))) {
      openMinute = mod(Number.parseInt(parts[0], 10), 24) * 60 + mod(Number.parseInt(parts[1], 10), 60);
    }
  }
  const openDay = openMinute !== null && o.open_day != null ? mod(Math.trunc(o.open_day), 7) : null;
  const splitDepth = o.deep ? DEEP_SPLIT_DEPTH : MAX_SPLIT_DEPTH;
  const splitCalls = o.deep ? DEEP_SPLIT_CALLS : MAX_SPLIT_CALLS;

  const summary = baseSummary("search");
  Object.assign(summary, {
    category,
    scope: {},
    filters: {
      included_type: itype,
      included_type_source:
        includedType === "auto" && itype ? "CATEGORY_TYPES" : itype ? "explicit" : "none (unmapped category, nothing sent)",
      strict_type: itype ? Boolean(strictType) : false,
      min_review_count: minReviewCount,
      require_phone: requirePhone,
      require_website: requireWebsite,
      min_rating: minRating,
      min_triage_score: minTriage,
      exclude_categories: excludes,
      chain_exclude: chains.length > 0,
      chain_names: chains,
      min_photos: minPhotos,
      max_per_sq_mile: maxPerSqMile,
      open_day: openDay,
      open_time: openMinute !== null ? o.open_time : null,
      deep: Boolean(o.deep),
      territory: "state=CA and city in nutribiotic/config/territory_areas.json",
    },
  });

  if (!isConfigured()) {
    summary.errors.push("Supabase is not configured on this deployment.");
    return summary;
  }
  if (!apiKey()) {
    summary.errors.push("NB_PLACES_API_KEY is not set on this deployment.");
    return summary;
  }

  const territory = loadTerritory();

  // ---- scope ----
  let circle: [number, number, number] | null = null;
  let shape: [number, number][] | null = null;
  const queries: [string, Rect | null, string][] = [];
  try {
    if (o.polygon) {
      shape = parsePolygon(o.polygon);
      const rect = rectFromPolygon(shape);
      const spanKm = haversineM(rect.low.latitude, rect.low.longitude, rect.high.latitude, rect.high.longitude) / 1000;
      summary.scope = {
        kind: "polygon",
        polygon: shape.map(([lat, lng]) => [lat, lng]),
        pins: shape.length,
        bbox: rect,
        diagonal_km: pyRound(spanKm, 2),
        label: `${shape.length} pins, ${spanKm.toFixed(1)} km across`,
      };
      log(`  polygon: ${shape.length} pins, bounding box ${spanKm.toFixed(1)} km corner to corner. Google is asked for the box; the drawn shape is enforced here.`);
      queries.push([category, rect, "drawn area"]);
    } else if (o.near || o.center) {
      let lat: number;
      let lng: number;
      let label: string;
      if (o.near) {
        [lat, lng, label] = await resolveNear(o.near, log);
      } else {
        lat = Number(o.center![0]);
        lng = Number(o.center![1]);
        label = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      }
      circle = [lat, lng, radiusM];
      summary.scope = { kind: "circle", center: [lat, lng], radius_m: radiusM, label };
      queries.push([category, rectFromCircle(lat, lng, radiusM), label]);
    } else {
      const want = new Set(o.areas ?? []);
      let sel: TerritoryArea[];
      if (want.size) {
        const known = new Set(TERRITORY_AREAS.map((a) => a.id));
        const unknown = [...want].filter((a) => !known.has(a)).sort();
        if (unknown.length) {
          summary.errors.push(`not territory areas: ${JSON.stringify(unknown)}`);
          return summary;
        }
        sel = TERRITORY_AREAS.filter((a) => want.has(a.id));
      } else {
        sel = TERRITORY_AREAS;
      }
      const skipped = sel.filter((a) => !a.anchors.length).map((a) => a.id);
      sel = sel.filter((a) => a.anchors.length);
      if (skipped.length) log(`skipping ${skipped.join(", ")}: no anchors to centre a search on (catch-all area, not a place)`);
      if (!sel.length) {
        summary.errors.push("no searchable area in scope");
        return summary;
      }
      summary.scope = { kind: "areas", areas: sel.map((a) => a.id), by_city: Boolean(o.by_city), skipped };
      for (const a of sel) {
        if (o.by_city) for (const c of a.cities) queries.push([`${category} in ${c}, CA`, null, a.id]);
        else queries.push([category, rectFromAnchors(a.anchors), a.id]);
      }
    }
  } catch (e) {
    if (e instanceof PlacesError) {
      summary.errors.push(e.message);
      return summary;
    }
    throw e;
  }

  // ---- Places ----
  log(`\nsearching Places for '${category}', ${queries.length} quer(ies). cache: ${pageCache.size} entr(ies)`);
  if (itype) {
    log(`  includedType=${itype}${strictType ? " strictTypeFiltering=true" : ""}  (Google filters the category before billing a result)`);
  } else if (includedType === "auto") {
    log("  no includedType: this category has no entry in CATEGORY_TYPES, so nothing was narrowed at Google's end");
  } else {
    log("  no includedType: switched off for this run, so nothing was narrowed at Google's end");
  }
  const raw = new Map<string, Place>();
  let calls = 0;
  const perLabel = counter();
  const perLabelMap = new Map<string, number>();
  const ceilings: string[] = [];
  try {
    for (const [q, rect, label] of queries) {
      const baseKey = `${SOURCE}|${q}|type=${itype || ""}|strict=${Boolean(itype) && Boolean(strictType)}|photos=${Boolean(minPhotos)}`;
      const [found, made, ceiling] = await searchRect(
        q, rect, baseKey, sleep, log, itype, strictType, fieldMask, 0, { n: splitCalls }, splitDepth,
      );
      calls += made;
      perLabel.add(label, found.size);
      perLabelMap.set(label, (perLabelMap.get(label) ?? 0) + found.size);
      if (ceiling) ceilings.push(label);
      for (const [pid, p] of found) if (!raw.has(pid)) raw.set(pid, p);
    }
  } catch (e) {
    if (!(e instanceof PlacesError)) throw e;
    summary.errors.push(`Places refused or was unreachable: ${e.message}`);
    summary.stages.search = { live_calls: calls, distinct_places: raw.size };
    return summary;
  }

  for (const [label, n] of [...perLabelMap].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    log(
      `  ${label.padEnd(26)} ${String(n).padStart(4)} result(s)` +
        (ceilings.includes(label) ? "   STILL AT GOOGLE'S CEILING after auto-splitting, some of this area's businesses were not returned" : ""),
    );
  }
  log(`\n${raw.size} distinct place(s), ${calls} live Places call(s) this run`);
  summary.stages.search = {
    queries: queries.length,
    live_calls: calls,
    distinct_places: raw.size,
    per_scope: perLabel.obj(),
    hit_google_ceiling: [...new Set(ceilings)].sort(),
  };

  // ---- filters, then triage ----
  const book = new Book(await loadLocalAccounts());
  log(`${book.rows.length} account(s) already in the book`);

  const la = laParts();
  const displayDay = openMinute !== null && openDay !== null ? openDay : la.weekday;

  const drops = counter();
  let survivors: Candidate[] = [];
  for (const p of raw.values()) {
    if ((p.businessStatus || "") === "CLOSED_PERMANENTLY") {
      drops.add("permanently closed");
      continue;
    }
    const excl = categoryExcluded(p, excludes);
    if (excl) {
      drops.add(`excluded category (${excl})`);
      continue;
    }
    const chainHit = chains.length ? chainExcluded(p, chains) : null;
    if (chainHit) {
      drops.add(`excluded chain (${chainHit})`);
      continue;
    }
    const state = component(p, "administrative_area_level_1").trim().toUpperCase();
    if (state !== "CA" && state !== "CALIFORNIA") {
      drops.add(`state ${state || "blank"}`);
      continue;
    }
    const city = component(p, "locality").trim();
    const lat = p.location?.latitude;
    const lng = p.location?.longitude;
    const area = areaFor(city, lat, lng, territory);
    if (!area) {
      drops.add("city outside the territory areas");
      continue;
    }
    if (shape !== null) {
      if (lat == null || lng == null) {
        drops.add("no coordinates, drawn area unverifiable");
        continue;
      }
      if (!pointInPolygon(lat, lng, shape)) {
        drops.add("inside the bounding box, outside the drawn area");
        continue;
      }
    } else if (circle) {
      if (lat == null || lng == null) {
        drops.add("no coordinates, radius unverifiable");
        continue;
      }
      if (haversineM(circle[0], circle[1], lat, lng) > circle[2]) {
        drops.add(`outside the ${circle[2].toFixed(0)}m radius`);
        continue;
      }
    }
    if (requirePhone && !(p.nationalPhoneNumber || "").trim()) {
      drops.add("no phone (require_phone)");
      continue;
    }
    if (openMinute !== null && openDay !== null) {
      const isOpen = openAt(p, openDay, openMinute);
      if (isOpen === null) {
        drops.add("hours not listed on Google");
        continue;
      }
      if (!isOpen) {
        drops.add(`closed at ${o.open_time} on ${WEEKDAY_LABELS[openDay]}`);
        continue;
      }
    }
    if (requireWebsite && !(p.websiteUri || "").trim()) {
      drops.add("no website (require_website)");
      continue;
    }
    const nRev = p.userRatingCount || 0;
    if (nRev < minReviewCount) {
      drops.add(`under ${minReviewCount} reviews`);
      continue;
    }
    if (minPhotos) {
      if ((p.photos ?? []).length < minPhotos) {
        drops.add(`under ${minPhotos} photo(s)`);
        continue;
      }
    }
    if (minRating > 0) {
      if (p.rating == null) {
        drops.add("no rating (min_rating)");
        continue;
      }
      if (Number(p.rating) < minRating) {
        drops.add(`under ${pyNum(minRating)} stars`);
        continue;
      }
    }

    const formatted = p.formattedAddress || "";
    const probe = {
      name: p.displayName?.text ?? null,
      phone: p.nationalPhoneNumber ?? null,
      street: splitStreet(formatted, city),
      city,
      postal: parsePostal(formatted),
      places_id: p.id ?? null,
    };
    const [hit, why] = book.find(probe, SOURCE, p.id);
    if (hit) {
      if (String(hit.erp_customer_code ?? "").trim()) drops.add("already a customer");
      else drops.add(`already in the book (${why})`);
      continue;
    }

    const [score, parts] = triageScore(p);
    if (score < minTriage) {
      drops.add(`triage < ${pyNum(minTriage)}`);
      continue;
    }

    survivors.push({
      key: p.id,
      ...probe,
      state: "CA",
      address: formatted,
      lat: lat ?? null,
      lng: lng ?? null,
      website: storeWebsite(p.websiteUri),
      website_raw: (p.websiteUri || "").trim() || null,
      places_primary_type: p.primaryType ?? null,
      places_types: p.types ?? null,
      places_rating: p.rating ?? null,
      places_rating_count: p.userRatingCount ?? null,
      places_status: p.businessStatus ?? null,
      hours_today: hoursTodayLine(p, displayDay),
      ...(minPhotos ? { places_photo_count: (p.photos ?? []).length } : {}),
      area,
      triage_score: score,
      triage_parts: parts,
      ...blankCandidateFields(),
    });
  }

  survivors.sort((a, b) => (b.triage_score as number) - (a.triage_score as number));
  log(`\n${survivors.length} survived the filters and triage`);

  if (maxPerSqMile > 0) {
    const cellCount = new Map<string, number>();
    const thinned: Candidate[] = [];
    let thinnedOut = 0;
    for (const c of survivors) {
      const lat = c.lat as number | undefined;
      const lng = c.lng as number | undefined;
      const cell = lat != null && lng != null ? sqMileCell(lat, lng) : null;
      if (cell !== null && (cellCount.get(cell) ?? 0) >= maxPerSqMile) {
        thinnedOut++;
        continue;
      }
      if (cell !== null) cellCount.set(cell, (cellCount.get(cell) ?? 0) + 1);
      thinned.push(c);
    }
    if (thinnedOut) {
      drops.set(`thinned, over ${maxPerSqMile} per sq mi`, thinnedOut);
      log(`  ${String(thinnedOut).padStart(5)}  thinned: over ${maxPerSqMile} per square mile (kept the highest triage in each)`);
    }
    survivors = thinned;
  }

  const dropped = drops.obj();
  for (const k of Object.keys(dropped).sort()) log(`  ${String(dropped[k]).padStart(5)}  dropped: ${k}`);

  let capped = 0;
  if (maxCandidates && survivors.length > maxCandidates) {
    capped = survivors.length - maxCandidates;
    log(`  capping at ${maxCandidates} (highest triage first)`);
    survivors = survivors.slice(0, maxCandidates);
  }

  summary.stages.triage = {
    considered: raw.size,
    survivors: survivors.length,
    capped_off: capped,
    dropped,
    book_size: book.rows.length,
  };
  summary.candidates = survivors;
  summary.ok = true;
  summary.finished_at = nowIso();
  return summary;
}

export async function enrichCandidates(candidates: Candidate[], sitePages: number, log: Log): Promise<Summary> {
  const summary = baseSummary("enrich");
  const stats = { attempted: 0, no_website: 0, pages_read: 0, with_about: 0, with_person: 0, with_fit: 0, failed: 0 };
  log(`\nreading ${candidates.length} candidate website(s), up to ${sitePages} page(s) each`);

  // One site per candidate, all read at once so the stage fits a function's
  // time limit; results are kept in the order the candidates came in. The
  // deadline keeps retries inside /api/search's maxDuration (300s).
  const deadline = Date.now() + 240_000;
  const infos = await Promise.all(
    candidates.map((c) => {
      const url = String(c.website_raw || c.website || "").trim();
      return url ? enrichFromSite(url, sitePages, deadline) : Promise.resolve(null);
    }),
  );

  const out: Candidate[] = [];
  candidates.forEach((orig, idx) => {
    const i = idx + 1;
    const c: Candidate = { ...orig, ...blankCandidateFields(), enriched: true };
    const label = String(c.name || "").slice(0, 34).padEnd(34);
    const info = infos[idx];
    if (!info) {
      stats.no_website++;
      c.site_failures = ["no website on file, nothing to read"];
      out.push(c);
      log(`  [${String(i).padStart(3)}/${candidates.length}] ${label} (no website)`);
      return;
    }
    stats.attempted++;
    const pages = (info.pages_read as string[]) ?? [];
    stats.pages_read += pages.length;
    c.pages_read = pages;
    c.site_failures = (info.failures as string[]) ?? [];
    const bits: string[] = [];
    const about = info.about as { text: string; url: string; basis: string } | undefined;
    if (about) {
      stats.with_about++;
      c.about = about.text;
      c.about_url = about.url;
      c.about_basis = about.basis;
      bits.push("about");
    }
    const person = info.person as { value: string; found_by: string } | undefined;
    if (person) {
      stats.with_person++;
      c.decision_maker_candidate = person.value;
      c.decision_maker_found_by = person.found_by;
      bits.push("person");
    }
    const fit = info.fit as { tags: Record<string, string[]>; catalog_terms: string[]; urls: string[] } | undefined;
    if (fit) {
      stats.with_fit++;
      c.fit_terms_by_tag = fit.tags;
      c.fit_tags = Object.keys(fit.tags).sort();
      c.catalog_terms = fit.catalog_terms;
      c.fit_urls = fit.urls;
      bits.push("fit:" + (c.fit_tags as string[]).join(","));
    }
    if (!pages.length) stats.failed++;
    out.push(c);
    const failures = c.site_failures as string[];
    log(
      `  [${String(i).padStart(3)}/${candidates.length}] ${label} ${bits.join(", ") || "(nothing stated)"}` +
        (failures.length && !pages.length ? `  !! ${failures[0].slice(0, 70)}` : ""),
    );
  });

  summary.stages.enrich = stats;
  summary.candidates = out;
  summary.ok = true;
  summary.finished_at = nowIso();
  return summary;
}

function candidateRow(c: Candidate, category: string, now: string): [Json, string] {
  const foundBySearch = `google_places: category search '${category}'`;
  const website = c.website ?? null;
  const status: Json = {
    triage: {
      score: c.triage_score ?? null,
      parts: c.triage_parts || {},
      found_by: "places_search_ingest.triage_score",
      at: now,
      note: "cheap-signal rank for a cold directory row. Not a fit or potential grade.",
    },
  };
  if (website) status.website = { found_by: foundBySearch, at: now };
  if (c.phone) status.phone = { found_by: foundBySearch, at: now };
  if (c.about) status.about = { found_by: `website: ${c.about_url ?? "None"}`, basis: c.about_basis ?? null, at: now };
  const fitTags = (c.fit_tags as string[] | undefined) ?? [];
  const catTerms = (c.catalog_terms as string[] | undefined) ?? [];
  if (fitTags.length || catTerms.length) {
    status.product_fit_signals = {
      tags: c.fit_terms_by_tag || {},
      catalog_terms: catTerms,
      found_by: "website: " + ((c.fit_urls as string[] | undefined) ?? []).join(", "),
      at: now,
      note: "terms the site states verbatim, in score.py's specializes_in vocabulary. Not a computed fit score.",
    };
  }
  if (c.decision_maker_candidate) {
    status.decision_maker_candidate = {
      value: c.decision_maker_candidate,
      confidence: "low",
      found_by: c.decision_maker_found_by ?? null,
      at: now,
    };
  }
  const current: string[] = [];
  if (c.about) current.push(String(c.about));
  if (catTerms.length) current.push("Site mentions: " + catTerms.slice(0, 12).join(", "));

  const rowId = randId("a");
  return [
    {
      id: rowId,
      name: c.name ?? null,
      channel: "unknown",
      street: c.street ?? null,
      city: c.city ?? null,
      state: "CA",
      postal: c.postal ?? null,
      lat: c.lat ?? null,
      lng: c.lng ?? null,
      phone: c.phone ?? null,
      website,
      places_id: c.places_id ?? null,
      places_primary_type: c.places_primary_type ?? null,
      places_types: c.places_types ?? null,
      places_rating: c.places_rating ?? null,
      places_rating_count: c.places_rating_count ?? null,
      places_status: c.places_status ?? null,
      area: c.area ?? null,
      lifecycle: "prospect",
      origin: "enriched",
      owner_name: OWNER_NAME,
      hubspot_owner_id: OWNER_ID,
      hubspot_sync_eligible: false,
      source: SOURCE,
      source_external_id: c.places_id ?? null,
      source_pulled_at: now,
      enrichment_status: status,
      current_state: current.join("\n\n") || null,
    },
    rowId,
  ];
}

function spreadSdrCalls(rows: Json[], callsPerDay: number, start: string, noteFor: (r: Json, area: string) => string): Json[] {
  const byArea = new Map<string, Json[]>();
  for (const r of rows) {
    const k = String(r.area);
    byArea.set(k, [...(byArea.get(k) ?? []), r]);
  }
  const out: Json[] = [];
  let day = start;
  for (const area of [...byArea.keys()].sort()) {
    const block = byArea.get(area)!;
    for (let i = 0; i < block.length; i += callsPerDay) {
      for (const r of block.slice(i, i + callsPerDay)) {
        out.push({
          id: randId("sdr"),
          account_id: r.id,
          kind: "call",
          scheduled_date: day,
          status: "pending",
          origin: "manual",
          notes: noteFor(r, area),
        });
      }
      day = addDays(day, 1);
    }
  }
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function landCandidates(
  candidates: Candidate[],
  o: { category: string; calls_per_day?: number; start_date?: string | null; write?: boolean },
  log: Log,
): Promise<Summary> {
  const category = o.category;
  const callsPerDay = o.calls_per_day ?? 15;
  const summary = baseSummary("land");
  summary.category = category;
  summary.written = false;

  if (!isConfigured()) {
    summary.errors.push("Supabase is not configured on this deployment.");
    return summary;
  }
  if (!candidates.length) {
    summary.errors.push("Nothing was picked, so nothing was landed.");
    return summary;
  }

  const now = nowIso();
  const start = o.start_date ? o.start_date : addDays(laParts().ymd, 1);

  const book = new Book(await loadLocalAccounts());
  const rows: Json[] = [];
  const landed: Candidate[] = [];
  const skipped: { name: unknown; why: string }[] = [];
  const sorted = [...candidates].sort(
    (a, b) =>
      cmp(String(a.area || ""), String(b.area || "")) ||
      cmp(String(a.city || ""), String(b.city || "")) ||
      cmp(String(a.name || ""), String(b.name || "")),
  );
  for (const c of sorted) {
    const [hit, why] = book.find(c, SOURCE, c.places_id);
    if (hit) {
      skipped.push({ name: c.name ?? null, why: `already in the book (${why})` });
      log(`  skipping ${c.name}: already in the book (${why})`);
      continue;
    }
    const [row, rowId] = candidateRow(c, category, now);
    rows.push(row);
    landed.push({ ...c, id: rowId });
  }

  if (!rows.length) {
    summary.stages.land = { accounts: 0, sdr_calls: 0, skipped };
    summary.candidates = [];
    summary.ok = true;
    summary.finished_at = nowIso();
    log("\nNothing left to land: every pick was already in the book.");
    return summary;
  }

  const noteFor = (_r: Json, area: string) =>
    `New prospect from the '${category}' Places sweep (${area}). Never contacted. No HubSpot record until this call is logged.`;
  const sdr = spreadSdrCalls(rows, callsPerDay, start, noteFor);
  const byArea: Record<string, number> = {};
  for (const r of rows) byArea[String(r.area)] = (byArea[String(r.area)] ?? 0) + 1;

  summary.candidates = landed;
  const land: Json = {
    accounts: rows.length,
    sdr_calls: sdr.length,
    by_area: byArea,
    first_sdr_day: start,
    calls_per_day: callsPerDay,
    skipped,
  };
  summary.stages.land = land;

  log(`\nwould insert ${rows.length} account(s) and ${sdr.length} SDR call(s), ${start} onward`);
  for (const area of Object.keys(byArea).sort()) log(`  ${area.padEnd(26)} ${String(byArea[area]).padStart(4)}`);

  if (!o.write) {
    log("\nDRY RUN. Nothing written. Re-run with write=True / --write.");
    log("No HubSpot call was made and none would be: this module does not import the hubspot module.");
    summary.ok = true;
    summary.finished_at = nowIso();
    return summary;
  }

  await insertRows("nb_accounts", rows);
  log(`  inserted ${rows.length}/${rows.length} account(s)`);
  await insertRows("nb_sdr_schedule", sdr);
  log(`  inserted ${sdr.length} SDR call(s), ${start} onward`);
  log(`\nDone. ${rows.length} prospect(s) in nb_accounts with hubspot_sync_eligible=false. Nothing reached HubSpot.`);
  summary.written = true;
  land.inserted_accounts = rows.length;
  land.inserted_sdr = sdr.length;
  summary.ok = true;
  summary.finished_at = nowIso();
  return summary;
}

// ---------------------------------------------------------------------------
// the stage door (stage_request): one stage from a parsed request object
// ---------------------------------------------------------------------------

const intOr = (v: unknown, d: number) => (v == null || v === "" ? d : Math.trunc(Number(v)));
const numOr = (v: unknown, d: number) => (v == null || v === "" ? d : Number(v));

export async function stageRequest(stage: string, req: Json, log: Log): Promise<Summary> {
  if (stage === "search") {
    return search(
      String(req.category ?? ""),
      {
        polygon: req.polygon || null,
        center: Array.isArray(req.center) && req.center.length ? (req.center as [number, number]) : null,
        near: (req.near as string) || null,
        areas: (req.areas as string[]) || null,
        radius_m: Number(req.radius_m || 2500),
        by_city: Boolean(req.by_city),
        included_type: "included_type" in req ? (req.included_type as string | null) : "auto",
        strict_type: "strict_type" in req ? Boolean(req.strict_type) : true,
        min_review_count: intOr(req.min_review_count, 30),
        require_phone: "require_phone" in req ? Boolean(req.require_phone) : true,
        require_website: "require_website" in req ? Boolean(req.require_website) : true,
        min_rating: numOr(req.min_rating, 4.0),
        min_triage_score: numOr(req.min_triage_score, 45.0),
        exclude_categories: (req.exclude_categories as string[]) || null,
        chain_exclude: Boolean(req.chain_exclude),
        chain_names: (req.chain_names as string[]) || null,
        min_photos: intOr(req.min_photos || 0, 0),
        max_per_sq_mile: intOr(req.max_per_sq_mile || 0, 0),
        open_day: req.open_day != null ? Math.trunc(Number(req.open_day)) : null,
        open_time: (req.open_time as string) || null,
        deep: Boolean(req.deep),
        max_candidates: intOr(req.max_candidates, 0),
        sleep: numOr(req.sleep, 0.3),
      },
      log,
    );
  }
  if (stage === "enrich") {
    return enrichCandidates([...((req.candidates as Candidate[]) || [])], intOr(req.site_pages, 4), log);
  }
  if (stage === "land") {
    return landCandidates(
      [...((req.candidates as Candidate[]) || [])],
      {
        category: String(req.category ?? ""),
        calls_per_day: intOr(req.calls_per_day, 15),
        start_date: (req.start_date as string) || null,
        write: Boolean(req.write),
      },
      log,
    );
  }
  throw new PlacesError(`unknown stage '${stage}'`);
}
