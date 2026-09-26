/**
 * Tier 1-2: the account's own site. Same source priority headhunter.py
 * enforces (team/about page first, the homepage second) and the same
 * structural facts read off the same pages (a mailto link, a tel: link, a
 * social profile), but the person-and-role read is done here by Anthropic
 * with a forced tool schema and verbatim-only instructions, per this
 * milestone's brief, rather than headhunter.py's regex engine, which this
 * app cannot run (no Mac, no Python).
 *
 * NO FABRICATION: the model sees only the page text this module fetched,
 * marked so it can tell a heading from a bio line, and is told to return
 * nothing for a person or a role it cannot point at on the page. It never
 * invents a phone or email; those are read structurally (a tel:/mailto:
 * link, or a 10-digit text match), never asked of the model.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  extractLinks,
  extractMailtos,
  extractPhone,
  extractSocials,
  fetchPage,
  formatPhone,
  headingMarkedText,
  isDirectory,
  rankTeamLinks,
  registrable,
} from "./html";
import type { FoundPerson, SourceTier } from "./types";

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

export type SitePassResult = {
  ran: boolean;
  skipped_reason?: string;
  pages_read: string[];
  failures: string[];
  people: FoundPerson[];
  names_without_role: { name: string; url: string }[];
  site_phone: string | null;
  site_email: string | null;
  site_hours: Record<string, string[][]> | null;
  socials: Record<string, string>;
};

const EMPTY: SitePassResult = {
  ran: false,
  pages_read: [],
  failures: [],
  people: [],
  names_without_role: [],
  site_phone: null,
  site_email: null,
  site_hours: null,
  socials: {},
};

const EXTRACT_TOOL = {
  name: "extract_site_people",
  description:
    "Extract every named person and the role the page prints for them, and business hours if explicitly stated. Verbatim only: never invent a name, a title, or an hour not printed on the page text given.",
  input_schema: {
    type: "object" as const,
    properties: {
      people: {
        type: "array",
        description:
          "Every distinct human this page names, each with the role the page prints beside them, on the line under them, or in their own bio sentence. A heading that is a business name, a section title, or a button (e.g. 'Book Now', 'Our Services') is not a person. Empty array if the page names nobody.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "The person's name exactly as printed, e.g. 'Hannah Hunt'." },
            title: {
              type: ["string", "null"],
              description:
                "The role as the page states it, e.g. 'Owner', 'Practice Manager', 'Stylist, PA-C'. A credential alone (RN, DDS) is not a role; if the page states both a role and a credential, include both as the page phrases it. Null if the page names this person but states no role for them anywhere near their name.",
            },
            is_decision_maker: {
              type: "boolean",
              description: "True only if the title states or clearly implies ownership or management (owner, founder, manager, director, president, buyer). False otherwise, including for a blank title.",
            },
            source_text: { type: "string", description: "The exact line or short phrase, copied verbatim, that names this person and states their role." },
          },
          required: ["name", "title", "is_decision_maker", "source_text"],
        },
      },
      hours_stated: {
        type: "boolean",
        description: "True only if the page text explicitly states operating hours.",
      },
      hours: {
        type: ["object", "null"],
        description:
          "Only when hours_stated is true: one key per day (mon,tue,wed,thu,fri,sat,sun), each an array of [open,close] 24-hour HH:MM pairs, empty array for a day stated closed. Null when hours_stated is false.",
      },
    },
    required: ["people", "hours_stated", "hours"],
  },
};

type ExtractOutput = {
  people: { name: string; title: string | null; is_decision_maker: boolean; source_text: string }[];
  hours_stated: boolean;
  hours: Record<string, string[][]> | null;
};

async function extractFromPage(text: string, url: string, tier: SourceTier): Promise<{ people: FoundPerson[]; hours: Record<string, string[][]> | null }> {
  if (!client || !text.trim()) return { people: [], hours: null };
  let out: ExtractOutput | null = null;
  try {
    const msg = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1200,
      system:
        "You read one page of a business's own website, marked with a control character before every heading so you can tell a heading from body text. " +
        "Extract only what the page states. A person needs a real name (not a title alone like 'The Owner') and, ideally, a role stated on the page; if a " +
        "capitalized heading could be a section title or a business name rather than a person, leave it out. Never guess a role from a name or a photo caption.",
      messages: [{ role: "user", content: text }],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "extract_site_people" },
    });
    const toolUse = msg.content.find((b) => b.type === "tool_use");
    if (toolUse && toolUse.type === "tool_use") out = toolUse.input as ExtractOutput;
  } catch {
    return { people: [], hours: null };
  }
  if (!out) return { people: [], hours: null };
  const people: FoundPerson[] = (out.people || [])
    .filter((p) => p.name && p.name.trim().length >= 2)
    .map((p) => ({
      name: p.name.trim(),
      title: p.title && p.title.trim() ? p.title.trim() : null,
      is_decision_maker: Boolean(p.is_decision_maker && p.title),
      source_tier: tier,
      found_by: `website: ${url}`,
      basis: `page text, "${(p.source_text || "").slice(0, 90)}"`,
      source_text: p.source_text || null,
      source_url: url,
    }));
  return { people, hours: out.hours_stated ? out.hours : null };
}

export async function runSitePass(website: string | null, accountName: string, maxPages = 4): Promise<SitePassResult> {
  if (!website || !website.trim()) return { ...EMPTY, skipped_reason: "No website on file." };
  if (isDirectory(website)) return { ...EMPTY, skipped_reason: `Only link on file is a directory profile (${website}).` };

  const home = await fetchPage(website);
  if (!home) return { ...EMPTY, skipped_reason: `Could not fetch ${website}.`, failures: [website] };
  if (isDirectory(home.finalUrl)) return { ...EMPTY, skipped_reason: `${website} redirects to a directory profile (${home.finalUrl}).` };

  const baseHost = new URL(home.finalUrl).hostname;
  const pagesRead: string[] = [home.finalUrl];
  const failures: string[] = [];
  const allPeople: FoundPerson[] = [];
  const seen = new Set<string>();
  let sitePhone: string | null = null;
  let siteEmail: string | null = null;
  let siteHours: Record<string, string[][]> | null = null;
  const socials: Record<string, string> = {};

  const links = extractLinks(home.html, home.finalUrl);
  const ranked = rankTeamLinks(links, home.finalUrl, maxPages - 1);

  for (const { url } of ranked) {
    const page = await fetchPage(url);
    if (!page) {
      failures.push(`${url}: fetch failed`);
      continue;
    }
    if (registrable(new URL(page.finalUrl).hostname) !== registrable(baseHost)) {
      failures.push(`${url}: redirected off the business, not read`);
      continue;
    }
    pagesRead.push(page.finalUrl);
    const mails = extractMailtos(page.html);
    if (mails.length && !siteEmail) siteEmail = mails[0];
    for (const [k, v] of Object.entries(extractSocials(extractLinks(page.html, page.finalUrl)))) socials[k] ??= v;
    const text = headingMarkedText(page.html);
    if (!sitePhone) sitePhone = extractPhone(page.html, text);
    const { people, hours } = await extractFromPage(text, page.finalUrl, "site_team");
    if (!siteHours && hours) siteHours = hours;
    for (const p of people) {
      const key = p.name.toLowerCase().replace(/[^a-z ]/g, "").trim();
      if (seen.has(key)) continue;
      seen.add(key);
      allPeople.push(p);
    }
  }

  // The homepage last, the weaker tier: a person already found on a team
  // page is never replaced by the same person found here.
  const homeMails = extractMailtos(home.html);
  if (homeMails.length && !siteEmail) siteEmail = homeMails[0];
  for (const [k, v] of Object.entries(extractSocials(links))) socials[k] ??= v;
  const homeText = headingMarkedText(home.html);
  if (!sitePhone) sitePhone = extractPhone(home.html, homeText);
  const { people: homePeople, hours: homeHours } = await extractFromPage(homeText, home.finalUrl, "site_other");
  if (!siteHours && homeHours) siteHours = homeHours;
  for (const p of homePeople) {
    const key = p.name.toLowerCase().replace(/[^a-z ]/g, "").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    allPeople.push(p);
  }

  // A person named in the business's own name is the business, not a
  // contact ("Juan Juan Salon" -> not a contact called Juan Juan).
  const accWords = new Set(accountName.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean));
  const ranked2 = allPeople.filter((p) => {
    const words = p.name.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);
    return !(words.length > 0 && words.every((w) => accWords.has(w)));
  });
  ranked2.sort((a, b) => (a.source_tier !== "site_team" ? 1 : 0) - (b.source_tier !== "site_team" ? 1 : 0) || Number(b.is_decision_maker) - Number(a.is_decision_maker));

  return {
    ran: true,
    pages_read: pagesRead,
    failures,
    people: ranked2,
    names_without_role: [],
    site_phone: sitePhone ? formatPhone(sitePhone) : null,
    site_email: siteEmail,
    site_hours: siteHours,
    socials,
  };
}
