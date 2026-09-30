/**
 * The one way this app reads a business's own website: SDR's "Enrich
 * further", Find Contacts' site pass, and Search's "look further" all fetch
 * through fetchWebPage, so a fix for one blocked or slow site is a fix for
 * all three.
 *
 * WHAT IT HANDLES, each seen on real stores in the book (2026-09-29 probe):
 *  - Bot-shaped User-Agents get a 403 (freshstartvitamins.com to both old
 *    agents, lassens.com and sprouts.com to one each). A real browser's
 *    headers get a 200 from all three.
 *  - Transient failures (a connect timeout on followyourheart.com that
 *    answered on the next try, 429/5xx): one bounded retry with backoff.
 *  - A dead or wrong host: the www / bare-host twin and http:// are tried
 *    before giving up.
 *  - Non-HTML answers (a PDF, an image), oversized pages (byte cap), and
 *    non-UTF-8 pages (charset from the header or the page's own meta tag).
 *  - A Cloudflare or similar challenge page is reported as "blocks
 *    automated readers", never read as the business's text.
 *  - Every attempt fits inside the caller's deadline, so a route never runs
 *    past its maxDuration on one slow site.
 *
 * Also the structured facts a site states in schema.org JSON-LD (phone,
 * email, opening hours): several stores print hours only there
 * (herbalregenesis.com, theheartmarketcafe.com, tokyocentral.com), where a
 * text scan never sees them. Read verbatim, never inferred.
 */
import "server-only";

export type WebPage = { html: string; finalUrl: string };
export type WebFetchResult = { ok: true; page: WebPage } | { ok: false; reason: string; blocked?: boolean };

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Upgrade-Insecure-Requests": "1",
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FetchOpts = {
  /** Per attempt. Default 9s. */
  timeoutMs?: number;
  /** Epoch ms the whole call must finish by, across retries and twins. */
  deadline?: number;
  /** Default 1.5 MB, enough for any real homepage's text. */
  maxBytes?: number;
  /** Extra tries after the first on a transient failure. Default 1. */
  retries?: number;
  /** Try the www/bare twin and http:// when the host itself fails. Default true. */
  tryAlternates?: boolean;
};

export function normalizeUrl(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Same page, other host spelling, then plain http: the fixes for a DNS
 *  miss or a TLS failure on an old small-business site. */
function alternates(href: string): string[] {
  const u = new URL(href);
  const out: string[] = [];
  const twin = new URL(href);
  twin.hostname = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
  out.push(twin.toString());
  if (u.protocol === "https:") {
    const plain = new URL(href);
    plain.protocol = "http:";
    out.push(plain.toString());
  }
  return out;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.length;
  }
  reader.cancel().catch(() => undefined);
  const out = new Uint8Array(Math.min(total, max));
  let off = 0;
  for (const p of parts) {
    const take = Math.min(p.length, out.length - off);
    out.set(p.subarray(0, take), off);
    off += take;
    if (off >= out.length) break;
  }
  return out;
}

function decode(bytes: Uint8Array, ctype: string): string {
  let charset = /charset=([^;]+)/i.exec(ctype)?.[1]?.trim().replace(/^["']|["']$/g, "");
  if (!charset) {
    // The page's own declaration, read from its first bytes as latin1 so
    // the sniff itself can't fail on a multi-byte sequence.
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function looksLikeChallenge(res: Response, html: string): boolean {
  if (res.headers.get("cf-mitigated")) return true;
  const head = html.slice(0, 6000);
  return /<title>\s*(?:Just a moment|Attention Required|Access denied|Please Wait)/i.test(head) || /challenge-platform|captcha-delivery|_Incapsula_Resource/i.test(head);
}

type Attempt = WebFetchResult & { transient?: boolean; hostFailure?: boolean };

async function attempt(href: string, timeoutMs: number, maxBytes: number): Promise<Attempt> {
  // One try/catch around the request AND the body: the timeout signal also
  // aborts a body that stalls mid-download, and that rejection arrives from
  // the read, long after fetch() itself resolved.
  try {
    return await attemptInner(href, timeoutMs, maxBytes);
  } catch (e) {
    const err = e as Error;
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, reason: timedOut ? "the site did not answer in time" : "the site could not be read", transient: timedOut };
  }
}

async function attemptInner(href: string, timeoutMs: number, maxBytes: number): Promise<Attempt> {
  let res: Response;
  try {
    res = await fetch(href, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const code = err.cause?.code || err.name;
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError" || /TIMEOUT/i.test(code || "");
    const hostFailure = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|CERT|SSL|TLS|ERR_TLS|UNABLE_TO_VERIFY|DEPTH_ZERO/i.test(code || "") || /certificate|ssl|tls/i.test(err.message || "");
    return { ok: false, reason: timedOut ? "the site did not answer in time" : "the site could not be reached", transient: timedOut || /ECONNRESET|UND_ERR/i.test(code || ""), hostFailure };
  }
  const ctype = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok) {
    const body = res.status === 403 || res.status === 503 ? decode(await readCapped(res, 20_000), ctype) : "";
    res.body?.cancel().catch(() => undefined);
    if (looksLikeChallenge(res, body)) return { ok: false, reason: "the site blocks automated readers", blocked: true };
    if (res.status === 403 || res.status === 401) return { ok: false, reason: "the site refused the read", blocked: true };
    if (res.status === 404 || res.status === 410) return { ok: false, reason: "the page does not exist" };
    return { ok: false, reason: `the site answered with an error (${res.status})`, transient: RETRYABLE_STATUS.has(res.status) };
  }
  if (ctype && !/html|xml/.test(ctype)) {
    res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: `not a web page (${ctype.split(";")[0]})` };
  }
  const html = decode(await readCapped(res, maxBytes), ctype);
  if (looksLikeChallenge(res, html)) return { ok: false, reason: "the site blocks automated readers", blocked: true };
  return { ok: true, page: { html, finalUrl: res.url || href } };
}

export async function fetchWebPage(rawUrl: string, opts: FetchOpts = {}): Promise<WebFetchResult> {
  const href = normalizeUrl(rawUrl);
  if (!href) return { ok: false, reason: "not a valid web address" };
  const timeoutMs = opts.timeoutMs ?? 9000;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const retries = opts.retries ?? 1;
  const left = () => (opts.deadline ? opts.deadline - Date.now() : Infinity);
  const budget = () => Math.min(timeoutMs, left() - 250);

  let last: Attempt = { ok: false, reason: "no time left to read the site" };
  for (let i = 0; i <= retries; i++) {
    if (budget() < 1500) return last;
    last = await attempt(href, budget(), maxBytes);
    if (last.ok || !last.transient) break;
    const wait = 600 * (i + 1);
    if (left() < wait + 2000) break;
    await sleep(wait);
  }
  if (last.ok || !last.hostFailure || opts.tryAlternates === false) return last;
  for (const alt of alternates(href)) {
    if (budget() < 1500) break;
    const r = await attempt(alt, budget(), maxBytes);
    if (r.ok) return r;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Placeholder guards: site templates come with fake contact details
// (blainesnutrition.com printed 000-000-0000 and email@site.com)
// ---------------------------------------------------------------------------

/** A ten-digit US number that could be dialed: no 0/1 area code or
 *  exchange, not one digit repeated, not a 555-01xx fiction number. */
export function isPlausiblePhone(ten: string): boolean {
  if (!/^\d{10}$/.test(ten)) return false;
  if (/^[01]/.test(ten) || /^\d{3}[01]/.test(ten)) return false;
  if (/^(\d)\1{9}$/.test(ten) || ten === "1234567890") return false;
  if (/^\d{3}55501\d{2}$/.test(ten)) return false;
  return true;
}

export function isTollFree(ten: string): boolean {
  return /^8(00|33|44|55|66|77|88)/.test(ten);
}

const PLACEHOLDER_EMAIL_DOMAINS = /(?:^|\.)(?:example\.(?:com|org|net)|site\.com|domain\.com|email\.com|yourdomain\.\w+|yoursite\.\w+|mysite\.com|company\.com|sentry\.io|wixpress\.com|sentry-next\.wixpress\.com)$/i;
const PLACEHOLDER_EMAIL_LOCAL = /^(?:email|your(?:name|email)?|name|user|username|example|test|john(?:\.?doe)?|jane(?:\.?doe)?)$/i;

export function isPlausibleEmail(addr: string): boolean {
  const m = /^([^@\s]+)@([^@\s]+\.[a-z]{2,})$/i.exec(addr);
  if (!m) return false;
  return !PLACEHOLDER_EMAIL_DOMAINS.test(m[2]) && !PLACEHOLDER_EMAIL_LOCAL.test(m[1]);
}

/** The number to keep from everything a site printed, in the order given
 *  (strongest source first): the first real local number, else the first
 *  real toll-free one, which is usually a corporate line. */
export function bestPhone(candidates: (string | null | undefined)[]): string | null {
  const real = candidates.filter((c): c is string => Boolean(c && isPlausiblePhone(c)));
  return real.find((c) => !isTollFree(c)) ?? real[0] ?? null;
}

// ---------------------------------------------------------------------------
// Structured facts the page states in schema.org JSON-LD
// ---------------------------------------------------------------------------

export type BusinessHours = Record<string, string[][]>;
export type JsonLdFacts = { phones: string[]; emails: string[]; hours: BusinessHours | null; description: string | null };

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_ALIASES: Record<string, (typeof DAYS)[number]> = {
  mo: "mon", mon: "mon", monday: "mon",
  tu: "tue", tue: "tue", tues: "tue", tuesday: "tue",
  we: "wed", wed: "wed", wednesday: "wed",
  th: "thu", thu: "thu", thur: "thu", thurs: "thu", thursday: "thu",
  fr: "fri", fri: "fri", friday: "fri",
  sa: "sat", sat: "sat", saturday: "sat",
  su: "sun", sun: "sun", sunday: "sun",
};

function dayOf(raw: string): (typeof DAYS)[number] | null {
  const k = raw.trim().toLowerCase().replace(/^https?:\/\/schema\.org\//, "").replace(/\.$/, "");
  return DAY_ALIASES[k] ?? null;
}

function hhmm(raw: string): string | null {
  const m = /^(\d{1,2}):?(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function expandDays(spec: string): (typeof DAYS)[number][] {
  const out: (typeof DAYS)[number][] = [];
  for (const part of spec.split(",")) {
    const [a, b] = part.split("-").map((s) => s.trim());
    const da = dayOf(a || "");
    if (!da) continue;
    if (!b) {
      out.push(da);
      continue;
    }
    const db = dayOf(b);
    if (!db) continue;
    let i = DAYS.indexOf(da);
    for (let n = 0; n < 7; n++) {
      out.push(DAYS[i]);
      if (DAYS[i] === db) break;
      i = (i + 1) % 7;
    }
  }
  return out;
}

function addSpan(hours: BusinessHours, days: (typeof DAYS)[number][], open: string | null, close: string | null) {
  for (const d of days) {
    hours[d] ??= [];
    if (open && close && !hours[d].some(([o, c]) => o === open && c === close)) hours[d].push([open, close]);
  }
}

/** `"Mo-Fr 09:00-17:00"`, `"Mo,Tu 10:00-17:00"`, `"Mo 10:00-17:00, Tu ..."`. */
function parseOpeningHoursString(s: string, hours: BusinessHours) {
  const re = /((?:[A-Za-z]{2,9}\s*(?:-\s*[A-Za-z]{2,9})?\s*,?\s*)+)\s+(\d{1,2}:?\d{2})\s*-\s*(\d{1,2}:?\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) addSpan(hours, expandDays(m[1].replace(/\s+/g, "")), hhmm(m[2]), hhmm(m[3]));
}

function parseSpecification(spec: Record<string, unknown>, hours: BusinessHours) {
  const rawDays = ([] as unknown[]).concat(spec.dayOfWeek ?? []);
  const days = rawDays.map((d) => (typeof d === "string" ? dayOf(d) : null)).filter((d): d is (typeof DAYS)[number] => Boolean(d));
  const open = typeof spec.opens === "string" ? hhmm(spec.opens) : null;
  const close = typeof spec.closes === "string" ? hhmm(spec.closes) : null;
  if (!days.length) return;
  // opens == closes == 00:00 is schema.org's own spelling of "closed".
  if (open === "00:00" && close === "00:00") addSpan(hours, days, null, null);
  else addSpan(hours, days, open, close);
}

function flattenLd(node: unknown, out: Record<string, unknown>[]) {
  if (Array.isArray(node)) {
    for (const n of node) flattenLd(n, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  out.push(obj);
  if (obj["@graph"]) flattenLd(obj["@graph"], out);
  for (const k of ["mainEntity", "location", "department", "subOrganization", "contactPoint"]) if (obj[k]) flattenLd(obj[k], out);
}

const BUSINESS_TYPES = /LocalBusiness|Store|Organization|Restaurant|Cafe|Pharmacy|Grocery|Medical|Clinic|Dentist|Physician|HealthAndBeauty|Spa|Salon|Gym|Health/i;

export function extractJsonLd(html: string): JsonLdFacts {
  const facts: JsonLdFacts = { phones: [], emails: [], hours: null, description: null };
  const nodes: Record<string, unknown>[] = [];
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, "");
    try {
      flattenLd(JSON.parse(raw), nodes);
    } catch {
      // A page's malformed JSON-LD is its own problem; skip that block.
    }
  }
  const hours: BusinessHours = {};
  for (const n of nodes) {
    const type = ([] as unknown[]).concat(n["@type"] ?? []).join(" ");
    if (!BUSINESS_TYPES.test(type) && !/ContactPoint|OpeningHoursSpecification/.test(type)) continue;
    for (const t of ([] as unknown[]).concat(n.telephone ?? [])) {
      const digits = String(t).replace(/\D/g, "");
      const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
      if (isPlausiblePhone(ten) && !facts.phones.includes(ten)) facts.phones.push(ten);
    }
    for (const e of ([] as unknown[]).concat(n.email ?? [])) {
      const addr = String(e).replace(/^mailto:/i, "").trim().toLowerCase();
      if (isPlausibleEmail(addr) && !facts.emails.includes(addr)) facts.emails.push(addr);
    }
    for (const s of ([] as unknown[]).concat(n.openingHours ?? [])) if (typeof s === "string") parseOpeningHoursString(s, hours);
    for (const s of ([] as unknown[]).concat(n.openingHoursSpecification ?? [])) if (s && typeof s === "object") parseSpecification(s as Record<string, unknown>, hours);
    if (!facts.description && typeof n.description === "string" && n.description.trim().length >= 40 && BUSINESS_TYPES.test(type)) {
      facts.description = n.description.trim();
    }
  }
  facts.hours = Object.keys(hours).length ? sanitizeHours(hours) : null;
  return facts;
}

/** Keeps only well-formed days and HH:MM pairs, whoever produced them (a
 *  model's tool output or a site's JSON-LD). Null when nothing survives. */
export function sanitizeHours(raw: unknown): BusinessHours | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: BusinessHours = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const day = dayOf(k);
    if (!day || !Array.isArray(v)) continue;
    const pairs: string[][] = [];
    for (const p of v) {
      if (!Array.isArray(p) || p.length !== 2) continue;
      const o = hhmm(String(p[0]));
      const c = hhmm(String(p[1]));
      if (o && c && o !== c) pairs.push([o, c]);
    }
    out[day] = pairs;
  }
  // Every day "closed" is a parse artefact, not a business.
  return Object.keys(out).length && Object.values(out).some((p) => p.length) ? out : null;
}

// ---------------------------------------------------------------------------
// Page shape helpers
// ---------------------------------------------------------------------------

/** Visible text only, for length checks and plain-text consumers. */
export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** A page built in the browser: almost no text in the HTML itself. What it
 *  says can't be read without running its JavaScript. */
export function isScriptShell(html: string): boolean {
  return visibleText(html).length < 400 && (html.match(/<script\b/gi) || []).length >= 3;
}

const HOURS_CUE = /\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)|\bhours\b|\bopen\b|\bclosed\b/gi;

/** The stretches of a long page that talk about hours, so a footer that
 *  prints them is still seen when the page is cut to fit a model's budget. */
export function hoursSnippets(text: string, maxLen = 1500): string {
  const spans: [number, number][] = [];
  for (const m of text.matchAll(HOURS_CUE)) {
    const s = Math.max(0, (m.index ?? 0) - 80);
    const e = Math.min(text.length, (m.index ?? 0) + 160);
    const prev = spans[spans.length - 1];
    if (prev && s <= prev[1]) prev[1] = Math.max(prev[1], e);
    else spans.push([s, e]);
  }
  // Keep the densest stretches: a real hours block has several cues close together.
  const scored = spans.map(([s, e]) => ({ s, e, n: (text.slice(s, e).match(HOURS_CUE) || []).length })).filter((x) => x.n >= 3);
  scored.sort((a, b) => b.n - a.n);
  const picked: { s: number; e: number }[] = [];
  let len = 0;
  for (const x of scored) {
    if (len + (x.e - x.s) > maxLen) continue;
    picked.push(x);
    len += x.e - x.s;
  }
  return picked
    .sort((a, b) => a.s - b.s)
    .map((x) => text.slice(x.s, x.e).trim())
    .join("\n...\n");
}

const CONTACT_RE = /(?:^|\/|\b)(?:contact(?:[-_ ]?us)?|hours|visit(?:[-_ ]?us)?|location(?:s)?|find[-_ ]?us|store[-_ ]?info)(?:$|\/|\b)/i;

/** The page on this site most likely to print hours, phone and email: a
 *  link the homepage itself prints first, then the addresses small-business
 *  site builders use (Shopify's /pages/contact-us, WordPress's /contact). */
export function contactPageCandidates(
  links: { url: string; anchor: string }[],
  baseUrl: string,
  limit = 2,
): { urls: string[]; guessed: boolean } {
  const base = new URL(baseUrl);
  const found: string[] = [];
  for (const { url, anchor } of links) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.hostname !== base.hostname) continue;
    const clean = `${u.origin}${u.pathname}`.replace(/\/$/, "");
    if (clean === `${base.origin}${base.pathname}`.replace(/\/$/, "")) continue;
    if ((CONTACT_RE.test(anchor) || CONTACT_RE.test(u.pathname)) && !found.includes(clean)) found.push(clean);
  }
  if (found.length) return { urls: found.slice(0, limit), guessed: false };
  return { urls: ["/contact", "/contact-us", "/pages/contact-us", "/pages/contact"].map((p) => new URL(p, base.origin).toString()).slice(0, limit), guessed: true };
}
