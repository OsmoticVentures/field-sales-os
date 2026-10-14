/**
 * NutriBiotic prospect fit on Search: Jev (TypeSafe System One) ranks the
 * new places a search found by how well they fit the line. A port of
 * bridges/nutribiotic/prospect_fit.py's pipeline(), cheapest step first:
 *
 *   rules    Places-closed, a named corporate chain, three or more storefronts
 *            under one brand in this search, a brand the rep's own book already
 *            marks chain-excluded or do-not-visit. No model.
 *   screen   one Jev call per place on Places facts: store type, natural
 *            focus, independence. At or above screen.pass earns a site read.
 *   verify   the homepage read, then one Jev call: the same three plus
 *            supplement evidence from the site's own words.
 *   border   within band of the bar only: one Jev yes/no. The Python file hands
 *            Jev's open band to Claude; this server does not, so an open-band
 *            answer keeps the composite's own verdict.
 *
 * EVERY QUESTION, WEIGHT AND BAR comes from prospect-fit.generated.ts, which
 * scripts/sync_search_config.mjs writes from `prospect_fit.py export`, which
 * reads bridges/decide/thresholds.json. Nothing here is retyped by hand.
 *
 * THE SCORE IS A RANK, NOT A GRADE. It rides on the search result and, when a
 * row is added, in enrichment_status.prospect_fit, beside triage. Never
 * nb_scores. Writes nothing, contacts no one.
 *
 * NEVER THROWS FOR A JEV FAILURE: the caller gets { ok:false, error } and the
 * candidates untouched, so the list still shows, in its own order.
 */
import "server-only";
import { CATALOG_TERMS } from "./config.generated";
import { PageText } from "./html";
import { PROSPECT_FIT as C, type FitDimension } from "./prospect-fit.generated";
import { fetchWebPage } from "../../shared/web-page";

type Json = Record<string, unknown>;
type Log = (msg: string) => void;

const API_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 20_000;
const WORKERS = 8;
const SITE_TIMEOUT_MS = 12_000;
const SITE_MAX_BYTES = 800_000;
/** The whole fit pass, start to finish. A place not reached by then stays unscored. */
export const FIT_BUDGET_MS = 150_000;

export type FitDim = { score: number; norm: number; confidence: number; level: string };
export type FitVerdict = {
  /** 0 to 100, the composite the row is ranked on, null when unscored. */
  score: number | null;
  fit: boolean;
  /** A practitioner's office: scoring is weaker on these, so the screen marks them. */
  clinic: boolean;
  why: string;
  stage: "rule" | "screen" | "verify";
  composite: number | null;
  screen_composite: number | null;
  dims: Record<string, FitDim>;
  site_read: boolean;
  chain_like: boolean;
  borderline?: { answer: boolean; p: number | null; source: "jev" | "composite" | "default" };
  dropped?: string;
};
export type FitSummary = {
  ok: boolean;
  error?: string;
  scored: number;
  unscored: number;
  fits: number;
  clinics: number;
  sites_read: number;
  seconds: number;
};

// ---- Jev ------------------------------------------------------------------------------
type Answer = { type?: string; score?: number; noul?: number; confidence?: number };

export class JevError extends Error {}

function apiKey(): string {
  return (process.env.TYPESAFE_API_KEY || "").trim();
}

export function jevConfigured(): boolean {
  return Boolean(apiKey());
}

async function jev(state: string, questions: Json): Promise<Record<string, Answer>> {
  const key = apiKey();
  if (!key) throw new JevError("TYPESAFE_API_KEY is not set on this deployment.");
  const body = JSON.stringify({ state, model: C.model, questions });
  let last: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json()) as { answers?: Record<string, Answer> };
        return data.answers ?? {};
      }
      const text = (await res.text()).slice(0, 160);
      if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 2) {
        last = new JevError(`Jev answered ${res.status}`);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      throw new JevError(`Jev answered ${res.status}: ${text}`);
    } catch (e) {
      if (e instanceof JevError && !/answered (429|529|5\d\d)$/.test(e.message)) throw e;
      last = e;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
    }
  }
  throw new JevError(`Jev could not be reached: ${last instanceof Error ? last.message : String(last)}`);
}

// ---- state and questions (prospect_fit.business_facts / state_for / questions_for) -------
function businessFacts(c: Json): Json {
  const types = ((c.places_types as string[] | null) ?? []).filter((t) => t !== "point_of_interest" && t !== "establishment");
  const out: Json = {
    name: c.name,
    city: c.city,
    google_primary_type: c.places_primary_type,
    google_types: types,
    google_rating: c.places_rating,
    google_review_count: c.places_rating_count,
    website: c.website,
  };
  for (const k of Object.keys(out)) {
    const v = out[k];
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) delete out[k];
  }
  return out;
}

function stateFor(c: Json, stage: "screen" | "verify", siteText: string): string {
  const s: Json = { nutribiotic_line: C.line, business: businessFacts(c) };
  if (stage === "verify") s.website_text = siteText.slice(0, C.site_chars);
  return JSON.stringify(s);
}

function dimsFor(stage: "screen" | "verify", siteText: string): FitDimension[] {
  const noSite = stage === "verify" && !siteText.trim();
  return C.dimensions.filter((d) => !(d.verify_only && (stage === "screen" || noSite)));
}

const dim = (id: string) => C.dimensions.find((d) => d.id === id)!;

type Judged = { composite: number | null; chain_like: boolean; site_read: boolean; dims: Record<string, FitDim> };

async function judge(c: Json, stage: "screen" | "verify", siteText: string): Promise<Judged> {
  const qs = dimsFor(stage, siteText);
  const questions: Json = {};
  for (const d of qs) questions[d.id] = d.question;
  const raw = await jev(stateFor(c, stage, siteText), questions);
  const dims: Record<string, FitDim> = {};
  for (const d of qs) {
    const a = raw[d.id];
    if (a?.score == null) continue;
    const top = d.question.criteria.length - 1;
    const score = Number(a.score);
    dims[d.id] = {
      score: round(score, 3),
      norm: round(score / top, 3),
      confidence: round(Number(a.confidence ?? 0), 3),
      level: d.question.criteria[Math.min(top, Math.max(0, pyRoundInt(score)))],
    };
  }
  const w = new Map(qs.map((d) => [d.id, stage === "screen" ? d.weight_screen : d.weight_verify]));
  const total = [...w.values()].reduce((a, b) => a + b, 0) || 1;
  const composite = qs.every((d) => dims[d.id])
    ? round([...w].reduce((s, [k, v]) => s + v * dims[k].norm, 0) / total, 4)
    : null;
  const gate = dim("independent").gate_below ?? 0;
  const chain_like = Boolean(dims.independent) && dims.independent.norm < gate;
  return { composite, chain_like, site_read: stage === "verify" && qs.some((d) => d.id === "supplement_evidence"), dims };
}

// ---- policy (prospect_fit.is_practice / unread_practice / practice_without_shelf / is_fit) --
function isPractice(v: Judged | null): boolean {
  const st = v?.dims.store_type?.score;
  return st != null && pyRoundInt(st) <= 2;
}
function isClinic(v: Judged | null): boolean {
  const st = v?.dims.store_type?.score;
  return st != null && pyRoundInt(st) === 2;
}
function practiceWithoutShelf(v: Judged): boolean {
  if (!isPractice(v)) return false;
  const sup = v.dims.supplement_evidence?.norm;
  return sup == null || sup < C.verify.practice_supplement_floor;
}
function unreadPractice(v: Judged): boolean {
  const st = v.dims.store_type?.norm ?? 0;
  return !v.site_read && st < C.verify.unread_store_floor;
}

async function borderline(c: Json, v: Judged, siteText: string): Promise<FitVerdict["borderline"] | undefined> {
  if (v.composite == null || v.chain_like || unreadPractice(v) || practiceWithoutShelf(v)) return undefined;
  if (Math.abs(v.composite - C.verify.pass) > C.verify.band) return undefined;
  const b = C.borderline;
  try {
    const a = await jev(stateFor(c, "verify", siteText), {
      q: { type: "noul", instructions: b.question, criteria: { true: b.true, false: b.false } },
    });
    const p = a.q?.noul == null ? null : Number(a.q.noul);
    if (p != null && p >= b.yes_above) return { answer: true, p, source: "jev" };
    if (p != null && p <= b.no_below) return { answer: false, p, source: "jev" };
    return { answer: v.composite >= C.verify.pass, p, source: "composite" };
  } catch {
    return { answer: b.on_error.toLowerCase() === "yes", p: null, source: "default" };
  }
}

// ---- the reason line (prospect_fit.why, plus the reasons a place is not a fit) ----------
function storeLabel(v: Judged): string {
  const d = v.dims.store_type;
  if (!d) return "";
  const labels = dim("store_type").labels ?? [];
  const i = pyRoundInt(d.score);
  return labels[i] ?? d.level.split(":")[0].split(" whose")[0];
}

function whyFit(v: Judged, terms: string[]): string {
  const bits = [storeLabel(v)];
  if ((v.dims.supplement_evidence?.norm ?? 0) >= C.why_strong) bits.push("site shows supplement or natural care stock");
  if ((v.dims.independent?.norm ?? 0) >= C.why_strong) bits.push("independent");
  if (terms.length) bits.push("site mentions " + terms.slice(0, 4).join(", "));
  return bits.filter(Boolean).join(", ");
}

function whyNot(v: Judged, stage: "screen" | "verify"): string {
  if (v.chain_like) return "Chain location, corporate buyer";
  if (stage === "verify" && isClinic(v) && unreadPractice(v)) return "Clinic, site would not load";
  if (stage === "verify" && isClinic(v) && practiceWithoutShelf(v)) return "Clinic, site shows no shelf";
  const bits = [storeLabel(v)];
  const nf = v.dims.natural_focus;
  if (nf && nf.norm < 0.5) bits.push("little natural health focus");
  if (stage === "verify" && v.site_read && (v.dims.supplement_evidence?.norm ?? 0) < 0.5) bits.push("no supplements on the site");
  return bits.filter(Boolean).join(", ");
}

// ---- rules before any model (prospect_fit.brand / brand_key / rule_drop) -----------------
const GENERIC = new Set(C.generic_words);
const CHAINS = C.chains.map((ch) => ({ label: ch.label, re: new RegExp(ch.pattern, "i") }));

export function brand(name: string): string {
  const head = (name || "").toLowerCase().split(/\s+[-|/@(]\s*|\s+at\s+/)[0];
  return head.replace(/'/g, "").replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(Boolean).join(" ");
}
export function brandKey(b: string): string {
  const toks = b.split(" ").filter(Boolean);
  return toks.length && toks[0].length >= 7 && !GENERIC.has(toks[0]) ? toks[0] : b;
}

function ruleDrop(c: Json, counts: Map<string, number>, book: Map<string, string>): string | null {
  if (String(c.places_status ?? "").toUpperCase() === "CLOSED_PERMANENTLY") return "Closed for good on Google";
  const name = String(c.name ?? "");
  const chain = CHAINS.find((ch) => ch.re.test(name));
  if (chain) return `Corporate chain, ${chain.label}`;
  const b = brandKey(brand(name));
  const n = counts.get(b) ?? 0;
  if (b && n >= C.multi_location) return `Chain, ${n} storefronts in this search`;
  const marked = book.get(b);
  if (marked) return marked === "chain_excluded" ? "Your book marks this brand a chain" : "Your book marks this brand do not visit";
  return null;
}

/** name -> verdict for brands the book already ruled out (prospect_fit.book_brands). */
export function bookBrands(rows: { name: string | null; chain_excluded: boolean | null; do_not_visit: boolean | null }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const k = brandKey(brand(r.name ?? ""));
    if (k.length >= 6) out.set(k, r.chain_excluded ? "chain_excluded" : "do_not_visit");
  }
  return out;
}

// ---- the homepage read (prospect_fit.read_home) -----------------------------------------
async function readHome(c: Json, deadline: number): Promise<string> {
  const url = String(c.website_raw || c.website || "").trim();
  if (!url) return "";
  const start = /^https?:\/\//.test(url) ? url : `https://${url}`;
  try {
    const r = await fetchWebPage(start, { timeoutMs: SITE_TIMEOUT_MS, maxBytes: SITE_MAX_BYTES, deadline });
    return r.ok ? new PageText(r.page.html).text() : "";
  } catch {
    return "";
  }
}

// ---- the pass ---------------------------------------------------------------------------
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const x = items[i++];
        await fn(x);
      }
    }),
  );
}

/** The number on screen. A chain-like answer is a zero, as in the rank prospect_fit.py acts on. */
function shown(v: Judged): number | null {
  if (v.composite == null) return null;
  return v.chain_like ? 0 : Math.round(v.composite * 100);
}

function rankOf(f: FitVerdict | undefined): number {
  if (!f) return -1;
  if (f.stage === "rule") return -2;
  if (f.score == null) return -1;
  return (f.fit ? 2 : 0) + f.score / 100;
}

/**
 * Scores every candidate in place (candidate.fit) and re-orders the list by fit.
 * On any Jev failure the list comes back as it went in, with ok:false.
 */
export async function scoreCandidates(
  candidates: Json[],
  book: Map<string, string>,
  log: Log,
  budgetMs = FIT_BUDGET_MS,
): Promise<{ candidates: Json[]; summary: FitSummary }> {
  const t0 = Date.now();
  const deadline = t0 + budgetMs;
  const summary: FitSummary = { ok: true, scored: 0, unscored: 0, fits: 0, clinics: 0, sites_read: 0, seconds: 0 };
  if (!candidates.length) return { candidates, summary };
  if (!jevConfigured()) {
    return { candidates, summary: { ...summary, ok: false, error: "Fit scoring is not set up on this server.", unscored: candidates.length } };
  }

  const counts = new Map<string, number>();
  for (const c of candidates) {
    const b = brandKey(brand(String(c.name ?? "")));
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }

  const verdicts = new Map<Json, FitVerdict>();
  const live: Json[] = [];
  for (const c of candidates) {
    const why = ruleDrop(c, counts, book);
    if (why) {
      verdicts.set(c, {
        score: 0, fit: false, clinic: false, why, stage: "rule", composite: null, screen_composite: null,
        dims: {}, site_read: false, chain_like: false, dropped: why,
      });
    } else live.push(c);
  }

  let failures = 0;
  let firstError = "";
  const screened = new Map<Json, Judged>();
  await pool(live, WORKERS, async (c) => {
    if (Date.now() > deadline) return;
    try {
      screened.set(c, await judge(c, "screen", ""));
    } catch (e) {
      failures++;
      firstError ||= e instanceof Error ? e.message : String(e);
    }
  });
  if (live.length && failures === live.length) {
    log(`fit: every screen call failed: ${firstError}`);
    return { candidates, summary: { ...summary, ok: false, error: "Fit scoring did not answer.", unscored: candidates.length } };
  }

  const passed = live.filter((c) => {
    const s = screened.get(c);
    return s && (s.composite ?? 0) >= C.screen.pass && !s.chain_like;
  });
  log(`fit: screen ${passed.length}/${screened.size} pass at ${C.screen.pass}`);

  await pool(passed, WORKERS, async (c) => {
    if (Date.now() > deadline) return;
    const site = await readHome(c, deadline);
    if (site) summary.sites_read++;
    if (Date.now() > deadline) return;
    let v: Judged;
    try {
      v = await judge(c, "verify", site);
    } catch {
      return; // keeps its screen verdict below
    }
    const s = screened.get(c)!;
    const lower = site.toLowerCase();
    const terms = site ? CATALOG_TERMS.filter((t) => lower.includes(t)) : [];
    const border = await borderline(c, v, site);
    const blocked = v.chain_like || unreadPractice(v) || practiceWithoutShelf(v);
    const fit = !blocked && (border ? border.answer : v.composite != null && v.composite >= C.verify.pass);
    verdicts.set(c, {
      score: shown(v),
      fit, clinic: isClinic(v),
      why: fit ? whyFit(v, terms) : whyNot(v, "verify"),
      stage: "verify", composite: v.composite, screen_composite: s.composite, dims: v.dims,
      site_read: v.site_read, chain_like: v.chain_like, ...(border ? { borderline: border } : {}),
    });
  });

  for (const c of live) {
    if (verdicts.has(c)) continue;
    const s = screened.get(c);
    if (!s) continue;
    verdicts.set(c, {
      score: shown(s),
      fit: false, clinic: isClinic(s), why: whyNot(s, "screen"), stage: "screen",
      composite: s.composite, screen_composite: s.composite, dims: s.dims, site_read: false, chain_like: s.chain_like,
    });
  }

  for (const c of candidates) {
    const f = verdicts.get(c);
    if (f) c.fit = f;
    if (f && f.score != null) summary.scored++;
    else summary.unscored++;
    if (f?.fit) summary.fits++;
    if (f?.clinic) summary.clinics++;
  }
  // stable: ties and unscored rows keep the search's own (triage) order
  const order = new Map(candidates.map((c, i) => [c, i]));
  const ranked = [...candidates].sort(
    (a, b) => rankOf(b.fit as FitVerdict | undefined) - rankOf(a.fit as FitVerdict | undefined) || order.get(a)! - order.get(b)!,
  );
  summary.seconds = round((Date.now() - t0) / 1000, 1);
  if (failures) summary.error = `${failures} could not be scored.`;
  log(`fit: ${summary.fits} fit of ${candidates.length}, ${summary.unscored} unscored, ${summary.seconds}s`);
  return { candidates: ranked, summary };
}

/** What a landed row keeps (prospect_fit.cmd_land's prospect_fit block). */
export function fitStatus(f: FitVerdict, now: string): Json {
  return {
    composite: f.composite,
    score: f.score,
    fit: f.fit,
    clinic: f.clinic,
    dims: Object.fromEntries(Object.entries(f.dims).map(([k, d]) => [k, { score: d.score, confidence: d.confidence, level: d.level }])),
    screen_composite: f.screen_composite,
    borderline: f.borderline ?? null,
    why: f.why,
    found_by: "ClientOS Search, lib/features/search/prospect-fit.ts (Jev), on Places facts" + (f.site_read ? " and the homepage text" : ""),
    at: now,
    note: "fit rank for a cold prospect, not a grade; never written to nb_scores",
  };
}

function round(n: number, d: number): number {
  const m = 10 ** d;
  return Math.round(n * m) / m;
}
/** Python's round() to an int: half to even. */
function pyRoundInt(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
