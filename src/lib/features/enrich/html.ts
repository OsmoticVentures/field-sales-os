/**
 * The one HTML reader this pipeline needs: no parser dependency is in this
 * app yet (headhunter.py uses Python's stdlib HTMLParser; there is no
 * equivalent here), so this is a small, regex-based reader scoped to
 * exactly what tier 1-2 asks of a page: its links (for finding a team/about
 * page), its heading-marked text (for the model to read names and roles
 * from), and the structural facts a page states outright, a mailto link, a
 * tel: link, a social profile, never guessed from prose.
 */
import "server-only";

export type FetchedPage = { html: string; finalUrl: string };

const UA = "Mozilla/5.0 (compatible; FieldSalesOS/1.0; +https://osmoticventures.com)";

export async function fetchPage(rawUrl: string, timeoutMs = 8000): Promise<FetchedPage | null> {
  try {
    const href = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
    const res = await fetch(href, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: { "User-Agent": UA },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const html = await res.text();
    return { html, finalUrl: res.url || href };
  } catch {
    return null;
  }
}

export type PageLink = { url: string; anchor: string };

/** Every same-document anchor tag, href resolved against `base`. No link is
 *  ever guessed; this only reads what the page itself printed. */
export function extractLinks(html: string, base: string): PageLink[] {
  const out: PageLink[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1].trim();
    if (!href || href.startsWith("javascript:")) continue;
    const anchor = stripTags(m[2]).trim();
    try {
      out.push({ url: new URL(href, base).toString(), anchor });
    } catch {
      // not a resolvable URL, skip it
    }
  }
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

const HEAD_MARK = "\x02";

/** The homepage/team-page text, headings marked so the model can tell "this
 *  line is a heading" from "this line is a bio sentence", the same
 *  distinction headhunter.py's TeamPage class keeps for its regex reader. */
export function headingMarkedText(html: string, maxLen = 6000): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(h[1-6])\b[^>]*>/gi, `\n${HEAD_MARK}`)
    .replace(/<\/(h[1-6])>/gi, "\n");
  const text = withoutNoise
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return text.slice(0, maxLen);
}

const MAILTO_RE = /mailto:([^"'?\s]+)/gi;

export function extractMailtos(html: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = MAILTO_RE.exec(html))) {
    const addr = m[1].trim().toLowerCase();
    if (addr.includes("@") && !out.includes(addr)) out.push(addr);
  }
  return out;
}

const TEL_RE = /href\s*=\s*["']tel:([^"']+)["']/gi;
const PHONE_TEXT_RE = /(?:\+?1[-.\s]?)?\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})\b/;

/** A tel: link is trusted over a text-scanned number (headhunter.py's own
 *  rule: a footer full of unrelated 10-digit strings is common). */
export function extractPhone(html: string, text: string): string | null {
  let m: RegExpExecArray | null = TEL_RE.exec(html);
  if (m) {
    const digits = m[1].replace(/\D/g, "");
    const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    if (ten.length === 10) return ten;
  }
  m = PHONE_TEXT_RE.exec(text);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

export function formatPhone(digits: string): string {
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

const SOCIAL_HOSTS: Record<string, string[]> = {
  instagram_url: ["instagram.com"],
  facebook_url: ["facebook.com", "fb.com"],
  linkedin_url: ["linkedin.com"],
};

export function extractSocials(links: PageLink[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { url } of links) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const [field, hosts] of Object.entries(SOCIAL_HOSTS)) {
      if (out[field]) continue;
      if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
        if (u.pathname.replace(/\/+$/, "")) out[field] = url.split("?")[0];
      }
    }
  }
  return out;
}

/** A registrable host ('www.lazyacres.com' -> 'lazyacres.com'), so a
 *  redirect to a subdomain of the same business is still "the same site". */
export function registrable(host: string): string {
  const parts = (host || "").toLowerCase().split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : host.toLowerCase();
}

const NOISE_RE = /(?:book|appointment|schedule|shop|product|cart|checkout|gift|blog|news|career|job|apply|privacy|terms|login)/i;
const TEAM_RE =
  /(?:^|\/|\b)(?:our[-_ ]?team|the[-_ ]?team|team|meet[-_ ]?the[-_ ]?team|meet[-_ ]?us|our[-_ ]?staff|staff|our[-_ ]?providers?|providers?|our[-_ ]?stylists?|stylists?|our[-_ ]?doctors?|doctors?|physicians?|practitioners?|our[-_ ]?people|people|leadership|our[-_ ]?experts?)(?:$|\/|\b)/i;
const ABOUT_RE = /(?:^|\/|\b)(?:about|about[-_ ]?us|our[-_ ]?story|who[-_ ]?we[-_ ]?are|owner|founder)(?:$|\/|\b)/i;

export type RankedLink = { url: string; label: "team page" | "about page" };

/** Same-host team/about links, best tier first, same shape as headhunter.py's
 *  ranked_team_links: a link that only LOOKS like a team page (a shop
 *  category, a booking funnel) is excluded unless the path itself is
 *  unambiguously a team path. */
export function rankTeamLinks(links: PageLink[], baseUrl: string, limit: number): RankedLink[] {
  const baseHost = new URL(baseUrl).hostname;
  const found = new Map<string, { rank: number; label: "team page" | "about page" }>();
  for (const { url, anchor } of links) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    if (u.hostname !== baseHost) continue;
    const clean = url.split("#")[0].replace(/\/$/, "");
    const hay = `${anchor} ${u.pathname}`;
    if (NOISE_RE.test(hay) && !TEAM_RE.test(u.pathname)) continue;
    if (TEAM_RE.test(anchor) || TEAM_RE.test(u.pathname)) {
      const prev = found.get(clean);
      if (!prev || prev.rank > 0) found.set(clean, { rank: 0, label: "team page" });
    } else if (ABOUT_RE.test(anchor) || ABOUT_RE.test(u.pathname)) {
      if (!found.has(clean)) found.set(clean, { rank: 1, label: "about page" });
    }
  }
  return [...found.entries()]
    .sort((a, b) => a[1].rank - b[1].rank)
    .slice(0, limit)
    .map(([url, v]) => ({ url, label: v.label }));
}

const DIRECTORY_HOSTS = [
  "yelp.com", "facebook.com", "instagram.com", "healthgrades.com", "fresha.com",
  "vagaro.com", "booksy.com", "styleseat.com", "square.site", "linktr.ee",
  "google.com", "mapquest.com", "yellowpages.com", "tripadvisor.com",
];

export function isDirectory(url: string): boolean {
  let host: string;
  try {
    host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return DIRECTORY_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}
