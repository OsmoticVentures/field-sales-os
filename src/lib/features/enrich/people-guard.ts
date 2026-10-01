/**
 * The deterministic gate between what a model says a page printed and what is
 * allowed to become a contact. A model reads the page; this file decides
 * whether the page actually says it (root AGENTS.md P2: where a script can
 * enforce it, the script is the authority). No imports, so it runs under plain
 * node in the tests.
 *
 * A person is kept only when the page text itself contains the name, the
 * quoted line, and the title. Whether they are a decision maker is read off
 * the title here, never taken from the model.
 */

export type RawPerson = { name: string; title: string | null; is_decision_maker?: boolean; source_text?: string | null };
export type Verdict = { ok: true; title: string | null; is_decision_maker: boolean } | { ok: false; reason: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const DECISION_ROLE = /\b(owner|co-?owner|founder|co-?founder|president|ceo|proprietor|manager|director|buyer|principal|partner|general manager|administrator)\b/i;

/** Page furniture and role labels that read as two capitalised words. */
const NOT_A_PERSON = /\b(cookies?|consent|privacy|policy|terms|login|log in|sign in|password|authentication|subscribe|newsletter|book now|contact us|connect with us|our services|learn more|read more|shop|cart|checkout|guarantee|frequently asked|payment methods?|stay connected|site information)\b/i;

export function isDecisionRole(title: string | null | undefined): boolean {
  return !!title && DECISION_ROLE.test(title);
}

export function verifyPerson(p: RawPerson, pageText: string): Verdict {
  const name = (p.name || "").trim();
  if (name.length < 2) return { ok: false, reason: "no name" };
  if (NOT_A_PERSON.test(name)) return { ok: false, reason: `"${name}" is page furniture, not a person` };
  const page = ` ${norm(pageText)} `;
  if (!page.includes(` ${norm(name)} `)) return { ok: false, reason: `"${name}" does not appear on the page` };
  const quote = (p.source_text || "").trim();
  if (quote && !page.includes(norm(quote))) return { ok: false, reason: `the quoted line for "${name}" is not on the page` };
  const title = p.title && p.title.trim() ? p.title.trim() : null;
  if (title && !page.includes(norm(title))) return { ok: false, reason: `the title "${title}" for "${name}" is not on the page` };
  return { ok: true, title, is_decision_maker: isDecisionRole(title) };
}

export type Citation = { url: string; text: string };

/** A web-search finding is kept only when a passage the search itself cited
 *  prints the name and the title together. The model's own prose proves
 *  nothing; the cited passage is the page speaking. Returns the passage so the
 *  contact stores what the page printed, with the page's own address. */
export function verifyCited(p: RawPerson, cited: Citation[]):
  | { ok: true; title: string; is_decision_maker: boolean; source_text: string; source_url: string }
  | { ok: false; reason: string } {
  const name = (p.name || "").trim();
  const title = (p.title || "").trim();
  if (name.length < 2 || !title) return { ok: false, reason: "a name and a title are both required" };
  if (NOT_A_PERSON.test(name)) return { ok: false, reason: `"${name}" is page furniture, not a person` };
  const words = norm(name).split(" ").filter(Boolean);
  const forms: Record<string, string[]> = { founder: ["founded by", "established by", "started by"], owner: ["owned by"] };
  const t = norm(title);
  for (const c of cited) {
    if (!/^https:\/\//.test(c.url || "")) continue;
    const page = ` ${norm(c.text)} `;
    if (!words.every((w) => page.includes(` ${w} `))) continue;
    if (!page.includes(` ${t} `) && !(forms[t] || []).some((f) => page.includes(` ${f} `))) continue;
    return { ok: true, title, is_decision_maker: isDecisionRole(title), source_text: c.text.trim().slice(0, 400), source_url: c.url };
  }
  return { ok: false, reason: `no cited passage prints "${name}" with "${title}"` };
}
