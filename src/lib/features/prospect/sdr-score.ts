/**
 * The NutriBiotic potential grade (A to E) and potential score (1 to 100),
 * ported rule for rule from bridges/nutribiotic (book_overview.py
 * potential_now, potential_raw, potential). This file is byte-identical in
 * ClientOS (osmotic-ventures/field-sales-os/src/lib/features/prospect/) and
 * the portfolio NutriBiotic OS (portfolio/src/app/nutribiotic/lib/), so the
 * two apps and the action lists sheet give the same answer for one account.
 * Change all three together; the parity script compares them account by
 * account.
 *
 * Potential, the size of the prize:
 *   1. My own field grade (potential_juan) always wins.
 *   2. Bought before: the best calendar year of ERP orders. A $3,000+,
 *      B $1,500+, C $500+, D $150+, else E. Three or more locations: one up.
 *   3. Never bought: fit, capped at B since nothing is proven. Natural
 *      grocery, supplement specialty, clinic practice start at C; clinic,
 *      grocery, pharmacy, spa start at D; anything else E. 300+ Google
 *      reviews or 3+ locations: one up. Under 25 reviews: one down.
 *   4. Nothing known at all: HQ's old label, else the OS grade.
 *   F and G (no retail, personal use) stay as graded.
 *
 * Potential, 1 to 100: what one more in-person visit from me is worth now.
 * 50 is the line: 50 and up I visit, under 50 is email and phone only.
 *   worth     from the grade: A 64, B 57, C 50, D 30, E 20, F and G 5, not
 *             graded 26. Inside a grade, proof counts: up to +4 for the best
 *             year of orders (peak / 750), +2 when the grade is my own field
 *             call, up to +3 for foot traffic (Google reviews / 200).
 *   momentum  readiness urgent +15, hot +12, normal +4, cold -10; a "no"
 *             newer than any yes -25, else a note in the last 120 days saying
 *             they want the line +10, +2 per named product up to +6; ordering
 *             in the ERP 12 months +6 plus up to +6 (rev12 / 400); ordering
 *             through me +8; a touch within 21 days +4, within 60 days +2.
 * Only A to C reach 50; D, E and not graded stop at 49 however warm.
 * Under 50 the raw sum is the score, capped at 49 and floored at 1. Above 50
 * it bends: 50 + 50 * (1 - e^(-(raw - 50) / 35)), capped at 100.
 *
 * Code, not a model: the note signals are fixed regular expressions over my
 * own capture text. Nothing here calls an LLM or stores a score.
 */

export type Readiness = "urgent" | "hot" | "normal" | "cold";

/** The columns the potential and the score read off an account. */
export type ScoreInput = {
  /** nb_v_account_potential.potential_grade, the OS letter. */
  tier: string | null;
  potential_juan?: string | null;
  potential_hq?: string | null;
  store_type?: string | null;
  channel?: string | null;
  locations_count?: number | null;
  places_rating_count?: number | null;
  readiness?: Readiness | null;
};

export type GradeFrom = "My grade" | "Order history" | "Fit" | "HQ" | "OS" | null;

/** The ERP export window the 12-month revenue is summed over. */
const ERP_12M = ["2025-07-01", "2026-06-30"] as const;
const NOTE_DAYS = 120;
const IN_PERSON = new Set(["visit", "meeting", "sample_drop", "staff_training"]);
const EMAILISH = new Set(["email_out", "email_in", "text"]);

const CORP_GATE =
  /corporate (buyer|buyers|buying|office|level buyer|is the one)|up to (the )?corporate|not up to (him|her|them)|regional coordinator|must route through/i;
const WANT =
  /\binterested in\b|\bvery interested\b|\blikes?\b|\bliked\b|\bloved?\b|\bwants? (to|a|an|the|more)\b|would like|ready to order|place an order|wants? a (phone )?call|asked for|reorder|\border(ed)? \w+ (units|cases|bottles)/i;
const NOPE = /not interested|no interest|declined|don'?t want|doesn'?t want|already carr|too expensive|not a fit/i;
const PRODUCTS =
  /clarity|gse|grapefruit seed|cd ?zinc|calcium ascorbate|electrolyte|peptide|cleanser|serum|body cream|body care|skin ?care|pro-?flora|defense|vitamin c|nasal|ear drops|shampoo/gi;

/** Server-side prefilters for the note reads. Each is a strict superset of
 *  the exact patterns above (every alternative contains one of these
 *  substrings), so filtering in Postgres only saves bytes, never a match. */
export const NOTE_PREFILTER = "(interest|lik|lov|want|order|asked for|declin|carr|expensive|not a fit)";
export const CORP_PREFILTER = "(corporate|not up to|regional coordinator|route through)";

const PRETTY: Record<string, string> = {
  gse: "GSE", cdzinc: "CDZinc", clarity: "Clarity+", calciumascorbate: "Calcium Ascorbate", vitaminc: "Vitamin C",
  proflora: "Pro-Flora", skincare: "Skin care", bodycare: "Body care", bodycream: "Body cream", eardrops: "Ear drops",
  grapefruitseed: "GSE", nasal: "Nasal spray", defense: "GSE Defense", electrolyte: "Electrolytes",
  peptide: "Peptide", cleanser: "Cleanser", serum: "Serum", shampoo: "Shampoo",
};

const LETTERS = "ABCDE";
const WORTH: Record<string, number> = { A: 64, B: 57, C: 50, D: 30, E: 20, F: 5, G: 5 };
/** The visit line: 50 and up I visit, under 50 is email and phone only. */
export const LINE = 50;
const GRADE_TOP = new Set(["natural_grocery", "specialty_supplement", "clinic_practice", "specialty"]);
const GRADE_MID = new Set(["clinic", "general_grocery", "spa_beauty", "grocery", "pharmacy"]);

// ---------------------------------------------------------------------------
// Raw rows, as read from Supabase, and the per-account signals built on them
// ---------------------------------------------------------------------------

export type RawOrder = { account_id: string; ordered_at: string; revenue_cents: number };
export type RawTouch = { account_id: string; at: string; effective_kind: string | null; outcome: string | null };
export type RawNote = { account_id: string; at: string; detail: string | null };
export type RawOrderEmail = { account_id: string | null; no_charge: boolean | null };

export type Signals = {
  /** Best calendar year of ERP order revenue, dollars. */
  peak: number;
  /** ERP revenue in the 12-month export window, dollars, rounded to cents. */
  rev12: number;
  /** Orders I placed (nb_order_emails, no-charge car stock excluded). */
  ordersMe: number;
  /** LA day of the last visit, call or email, "" when none. */
  lastTouch: string;
  /** An in-person touch logged a decline. */
  declined: boolean;
  /** LA day of the newest note saying they want the line / saying no. */
  want: string;
  nope: string;
  /** Product keys named in a "want" note. */
  products: string[];
  /** A note says buying is decided above the store. */
  corp: boolean;
};

const LA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });

/** The LA calendar day of a timestamp, YYYY-MM-DD. */
export function laDay(iso: string | Date): string {
  return LA_DAY.format(typeof iso === "string" ? new Date(iso) : iso);
}

export function dayDiff(later: string, earlier: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Python's round(): half to even, so the app and the sheet never differ by one. */
function roundHalfEven(n: number): number {
  const f = Math.floor(n);
  const d = n - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function buildSignals(
  raw: { orders: RawOrder[]; touches: RawTouch[]; notes: RawNote[]; corpNotes: RawNote[]; orderEmails: RawOrderEmail[] },
  today: string = laDay(new Date()),
): Map<string, Signals> {
  const out = new Map<string, Signals>();
  const get = (id: string): Signals => {
    let s = out.get(id);
    if (!s) {
      s = { peak: 0, rev12: 0, ordersMe: 0, lastTouch: "", declined: false, want: "", nope: "", products: [], corp: false };
      out.set(id, s);
    }
    return s;
  };

  const year = new Map<string, number>();
  const rev12 = new Map<string, number>();
  for (const o of raw.orders) {
    const k = `${o.account_id}|${o.ordered_at.slice(0, 4)}`;
    year.set(k, (year.get(k) ?? 0) + o.revenue_cents / 100);
    if (ERP_12M[0] <= o.ordered_at && o.ordered_at <= ERP_12M[1]) {
      rev12.set(o.account_id, (rev12.get(o.account_id) ?? 0) + o.revenue_cents / 100);
    }
  }
  for (const [k, v] of year) {
    const s = get(k.split("|")[0]);
    s.peak = Math.max(s.peak, v);
  }
  for (const [id, v] of rev12) get(id).rev12 = round2(v);

  for (const e of raw.orderEmails) if (e.account_id && !e.no_charge) get(e.account_id).ordersMe += 1;

  for (const t of raw.touches) {
    const k = t.effective_kind ?? "";
    if (!(IN_PERSON.has(k) || k === "call" || EMAILISH.has(k))) continue;
    const s = get(t.account_id);
    const d = laDay(t.at);
    if (d > s.lastTouch) s.lastTouch = d;
    if (IN_PERSON.has(k) && t.outcome === "declined") s.declined = true;
  }

  for (const n of raw.corpNotes) if (n.detail && CORP_GATE.test(n.detail)) get(n.account_id).corp = true;

  const products = new Map<string, Set<string>>();
  for (const n of raw.notes) {
    if (!n.detail) continue;
    const d = laDay(n.at);
    if (dayDiff(today, d) > NOTE_DAYS) continue;
    const s = get(n.account_id);
    if (NOPE.test(n.detail) && d > s.nope) s.nope = d;
    if (WANT.test(n.detail)) {
      if (d > s.want) s.want = d;
      const set = products.get(n.account_id) ?? new Set<string>();
      for (const m of n.detail.matchAll(PRODUCTS)) set.add(m[0].toLowerCase().replace(/ /g, "").replace(/-/g, ""));
      products.set(n.account_id, set);
    }
  }
  for (const [id, set] of products) get(id).products = [...set].sort();
  return out;
}

// ---------------------------------------------------------------------------
// Potential and score
// ---------------------------------------------------------------------------

function bump(g: string, n: number): string {
  return LETTERS[Math.max(0, Math.min(4, LETTERS.indexOf(g) - n))];
}

export function potentialNow(a: ScoreInput, peak: number): { grade: string | null; from: GradeFrom } {
  const os = a.tier ?? "";
  if (os === "F" || os === "G") return { grade: os, from: "HQ" };
  if (a.potential_juan && LETTERS.includes(a.potential_juan) && a.potential_juan.length === 1) {
    return { grade: a.potential_juan, from: "My grade" };
  }
  const locs = a.locations_count ?? 0;
  if (peak > 0) {
    const g = peak >= 3000 ? "A" : peak >= 1500 ? "B" : peak >= 500 ? "C" : peak >= 150 ? "D" : "E";
    return { grade: locs >= 3 ? bump(g, 1) : g, from: "Order history" };
  }
  const t = (a.store_type || a.channel || "").toLowerCase();
  if (t && t !== "unknown") {
    let g = GRADE_TOP.has(t) ? "C" : GRADE_MID.has(t) ? "D" : "E";
    const rc = a.places_rating_count;
    if ((rc ?? 0) >= 300 || locs >= 3) g = bump(g, 1);
    else if (rc !== null && rc !== undefined && rc < 25) g = bump(g, -1);
    return { grade: g, from: "Fit" };
  }
  const hq = (a.potential_hq ?? "").slice(0, 1);
  if (hq && LETTERS.includes(hq)) return { grade: hq, from: "HQ" };
  return { grade: os || null, from: os ? "OS" : null };
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function listProducts(keys: string[]): string {
  const names = [...new Set(keys.map((k) => PRETTY[k] ?? k))];
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The raw sum, before the bend, mirroring book_overview.potential_raw term
 *  for term (same float order, so the rounding never differs). */
export function potentialRaw(a: ScoreInput, s: Signals, grade: string | null, from: GradeFrom, today: string): number {
  let n = grade && grade in WORTH ? WORTH[grade] : 26;
  n += Math.min(4, s.peak / 750) + (from === "My grade" ? 2 : 0) + Math.min(3, (a.places_rating_count ?? 0) / 200);
  const rd = a.readiness;
  n += rd === "urgent" ? 15 : rd === "hot" ? 12 : rd === "normal" ? 4 : rd === "cold" ? -10 : 0;
  if (saidNo(s)) n -= 25;
  else if (s.want) n += 10 + Math.min(6, 2 * s.products.length);
  if (s.rev12 > 0) n += 6 + Math.min(6, s.rev12 / 400);
  if (s.ordersMe) n += 8;
  if (s.lastTouch) {
    const age = dayDiff(today, s.lastTouch);
    n += age <= 21 ? 4 : age <= 60 ? 2 : 0;
  }
  // Only A to C reach the line; D, E and not graded stop at 49.
  if (grade !== "A" && grade !== "B" && grade !== "C") n = Math.min(n, LINE - 1);
  return n;
}

/** The potential, 1 to 100, before a suppressor cap. Exported for the parity check. */
export function sdrScore(a: ScoreInput, s: Signals, grade: string | null, today: string, from: GradeFrom = null): number {
  const raw = potentialRaw(a, s, grade, from, today);
  if (raw < LINE) return Math.max(1, Math.min(LINE - 1, roundHalfEven(raw)));
  return Math.min(100, roundHalfEven(LINE + 50 * (1 - Math.exp(-(raw - LINE) / 35))));
}

export const EMPTY_SIGNALS: Signals = { peak: 0, rev12: 0, ordersMe: 0, lastTouch: "", declined: false, want: "", nope: "", products: [], corp: false };

export function saidNo(s: Signals): boolean {
  return s.declined || (s.nope !== "" && s.nope >= s.want);
}

/** The evidence behind a score, in plain words. */
export function sdrClauses(a: ScoreInput, s: Signals, grade: string | null, from: GradeFrom, today: string): string[] {
  const out: string[] = [];
  if (grade) out.push(`Potential ${grade}${from === "My grade" ? ", my grade" : from === "Order history" ? `, best year ${usd(s.peak)}` : ""}`);
  if (a.readiness) out.push(a.readiness);
  if (saidNo(s)) out.push("said no");
  else if (s.want) out.push(s.products.length ? `wants ${listProducts(s.products)}` : "wants the line");
  if (s.rev12 > 0) out.push(`${usd(s.rev12)} in the last 12 months`);
  if (s.ordersMe) out.push(`${s.ordersMe} order${s.ordersMe === 1 ? "" : "s"} through me`);
  if (s.lastTouch) {
    const d = dayDiff(today, s.lastTouch);
    out.push(d === 0 ? "touched today" : `last touch ${d}d ago`);
  }
  return out;
}
