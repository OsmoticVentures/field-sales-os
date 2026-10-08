// Pass/fail checks for the known failure modes of each AI task, applied to
// rows of nb_ai_runs (a run's input and output excerpts). Pure: no network,
// no model. Each check returns null when the run passes it, or a short
// reason when it fails. A check that cannot judge a row (the excerpt was
// clipped, the output is not JSON) skips it rather than guess.
import { TouchpointSchema } from "../../src/lib/features/visit/touchpoint-schema.ts";

export type RunRow = {
  id?: number;
  created_at?: string;
  task: string;
  model: string;
  ok: boolean;
  validation: string;
  attempts: number;
  fallback_used: boolean;
  latency_ms: number;
  stop_reason: string | null;
  input_excerpt: string;
  output_excerpt: string | null;
  error: string | null;
};

export type Check = { name: string; run: (row: RunRow, out: Record<string, unknown> | null) => string | null };

const clipped = (s: string | null | undefined) => (s ?? "").endsWith("…");
const lower = (s: unknown) => String(s ?? "").toLowerCase();
const inInput = (row: RunRow, v: unknown) => lower(row.input_excerpt).includes(lower(v).trim());
const EM_DASH = "\u2014";

/** Every task: the plumbing failures. */
export const COMMON: Check[] = [
  { name: "call failed", run: (r) => (r.ok ? null : `${r.validation}: ${r.error ?? "no reply"}`) },
  { name: "reply off schema", run: (r) => (r.validation === "fail" ? r.error ?? "did not validate" : null) },
  { name: "needed a retry", run: (r) => (r.ok && r.attempts > 1 ? `${r.attempts} attempts` : null) },
  { name: "fell back", run: (r) => (r.fallback_used ? `served by ${r.model}` : null) },
  { name: "cut off", run: (r) => (r.stop_reason === "max_tokens" ? "hit max_tokens" : null) },
  { name: "refused", run: (r) => (r.stop_reason === "refusal" ? "refusal" : null) },
  { name: "slow (over 20s)", run: (r) => (r.latency_ms > 20_000 ? `${Math.round(r.latency_ms / 1000)}s` : null) },
];

const VAGUE = /^(follow ?up|check in|touch base|keep in touch|revisit|stay on it|circle back)\.?$/i;
const THIRD_PERSON = /\b(the rep|rep (visited|called|spoke|met))\b|^(visited|called|spoke|met)\b/i;
const CONTACT_CLAIM = /\bI (visited|called|spoke|met|talked|emailed|texted)\b/i;

export const TASK_CHECKS: Record<string, Check[]> = {
  touchpoint_extract: [
    {
      name: "schema",
      run: (r, o) => {
        if (!o || clipped(r.output_excerpt)) return null;
        const p = TouchpointSchema.safeParse(o);
        return p.success ? null : p.error.issues.slice(0, 2).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      },
    },
    {
      name: "third person in the record",
      run: (_r, o) => {
        const a = (o?.activity ?? {}) as Record<string, unknown>;
        const hit = [a.detail, a.hubspot_summary].find((t) => THIRD_PERSON.test(String(t ?? "")));
        return hit ? String(hit).slice(0, 80) : null;
      },
    },
    {
      name: "field note claims a contact",
      run: (_r, o) => {
        const a = (o?.activity ?? {}) as Record<string, unknown>;
        return a.kind === "field_note" && CONTACT_CLAIM.test(String(a.hubspot_summary ?? "")) ? String(a.hubspot_summary).slice(0, 80) : null;
      },
    },
    {
      name: "invented person",
      run: (r, o) => {
        if (clipped(r.input_excerpt)) return null;
        const people = (o?.people ?? []) as Record<string, unknown>[];
        const bad = people.flatMap((p) => [p.first_name, p.last_name].filter((n) => n && !inInput(r, n)));
        return bad.length ? `not in the note: ${bad.join(", ")}` : null;
      },
    },
    {
      name: "invented email or phone",
      run: (r, o) => {
        if (clipped(r.input_excerpt)) return null;
        const people = (o?.people ?? []) as Record<string, unknown>[];
        const facts = (o?.account_facts ?? {}) as Record<string, unknown>;
        const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
        const inputDigits = digits(r.input_excerpt);
        const bad: string[] = [];
        for (const e of [...people.map((p) => p.email), facts.email]) if (e && !inInput(r, e)) bad.push(String(e));
        for (const ph of [...people.map((p) => p.phone), facts.phone]) if (ph && !inputDigits.includes(digits(ph).slice(-7))) bad.push(String(ph));
        return bad.length ? bad.join(", ") : null;
      },
    },
    {
      name: "buyer by default",
      run: (r, o) => {
        const people = (o?.people ?? []) as Record<string, unknown>[];
        return people.some((p) => p.role_tag === "buyer") && !/\bbuy(er|s|ing)?\b|orders?\b|purchas/i.test(r.input_excerpt) ? "role_tag buyer, note never says so" : null;
      },
    },
    {
      name: "vague next step",
      run: (_r, o) => (VAGUE.test(String(o?.next_step ?? "").trim()) ? String(o?.next_step) : null),
    },
    {
      name: "closed without a closure",
      run: (r, o) => {
        const a = (o?.activity ?? {}) as Record<string, unknown>;
        return a.outcome === "closed" && !/clos|out of business|shut|empty|gone|another business|vacant/i.test(r.input_excerpt) ? "outcome closed" : null;
      },
    },
    {
      name: "time with no time stated",
      run: (r, o) => {
        const acts = (o?.calendar_actions ?? []) as Record<string, unknown>[];
        const when = /\b(mon|tue|wed|thu|fri|sat|sun)\w*|tomorrow|tonight|today|next|week|month|\d{1,2}(:\d{2})?\s*(am|pm)|\d{1,2}\/\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december/i;
        return acts.some((c) => c.when_iso) && !when.test(r.input_excerpt) ? "when_iso set, the note names no time" : null;
      },
    },
  ],
  outbound_decide: [
    {
      name: "email nobody mentioned",
      run: (r, o) => (o?.email_needed === true && !/e-?mail|send|sent|mail|price ?(sheet|list)|catalog|quote|pdf|info/i.test(r.input_excerpt) ? String(o.ask ?? "").slice(0, 80) : null),
    },
  ],
  outbound_compose: [
    { name: "em dash", run: (_r, o) => (String(o?.body ?? "").includes(EM_DASH) || String(o?.subject ?? "").includes(EM_DASH) ? "em dash in the draft" : null) },
    { name: "says ship", run: (_r, o) => (/\bship(s|ping|ped)?\b/i.test(`${o?.subject ?? ""} ${o?.body ?? ""}`) ? "ship in the draft" : null) },
    {
      name: "number not in the note",
      run: (r, o) => {
        if (clipped(r.input_excerpt) || !o?.writable) return null;
        const said = new Set(r.input_excerpt.match(/\d+/g) ?? []);
        const bad = (String(o.body ?? "").match(/\d+/g) ?? []).filter((n) => !said.has(n));
        return bad.length ? `new numbers: ${bad.join(", ")}` : null;
      },
    },
    { name: "writable but empty", run: (_r, o) => (o?.writable === true && !String(o.body ?? "").trim() ? "empty body" : null) },
  ],
  enrich_site_people: [
    {
      name: "person not on the page",
      run: (r, o) => {
        if (clipped(r.input_excerpt)) return null;
        const bad = ((o?.people ?? []) as Record<string, unknown>[]).map((p) => p.name).filter((n) => n && !inInput(r, n));
        return bad.length ? bad.join(", ") : null;
      },
    },
  ],
  enrich_websearch_extract: [
    {
      name: "person not in the findings",
      run: (r, o) => {
        if (clipped(r.input_excerpt)) return null;
        const bad = ((o?.people ?? []) as Record<string, unknown>[]).map((p) => p.name).filter((n) => n && !inInput(r, n));
        return bad.length ? bad.join(", ") : null;
      },
    },
  ],
  expenses_classify: [
    { name: "odometer not digits", run: (_r, o) => (o?.odometer_reading && !/^\d+(\.\d+)?$/.test(String(o.odometer_reading)) ? String(o.odometer_reading) : null) },
    { name: "amount not a number", run: (_r, o) => (o?.amount && !/^\d+(\.\d{1,2})?$/.test(String(o.amount)) ? String(o.amount) : null) },
    { name: "low confidence, fields filled", run: (_r, o) => (o?.confidence === "low" && (o.amount || o.odometer_reading) ? "a guess reached a field" : null) },
  ],
  mileage_odometer: [{ name: "reading not digits", run: (_r, o) => (o?.reading && !/^\d+(\.\d+)?$/.test(String(o.reading)) ? String(o.reading) : null) }],
  search_suggest_categories: [
    {
      name: "suggests the category itself",
      run: (r, o) => {
        const cat = lower(r.input_excerpt.match(/Search category: "([^"]+)"/)?.[1] ?? "");
        const hit = ((o?.suggestions ?? []) as Record<string, unknown>[]).find((s) => cat && (lower(s.category).includes(cat) || cat.includes(lower(s.category))));
        return hit ? String(hit.category) : null;
      },
    },
  ],
};

export function parseOutput(row: RunRow): Record<string, unknown> | null {
  const t = row.output_excerpt ?? "";
  if (!t.trim() || clipped(t)) return null;
  try {
    const v = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type Failure = { task: string; check: string; id: number | undefined; at: string | undefined; reason: string };

/** Every failing (row, check) pair across the rows. */
export function evaluate(rows: RunRow[]): { failures: Failure[]; counts: Map<string, { runs: number; failed: Map<string, number> }> } {
  const failures: Failure[] = [];
  const counts = new Map<string, { runs: number; failed: Map<string, number> }>();
  for (const row of rows) {
    const c = counts.get(row.task) ?? { runs: 0, failed: new Map<string, number>() };
    c.runs += 1;
    counts.set(row.task, c);
    const out = row.ok ? parseOutput(row) : null;
    for (const check of [...COMMON, ...(row.ok ? TASK_CHECKS[row.task] ?? [] : [])]) {
      let reason: string | null = null;
      try {
        reason = check.run(row, out);
      } catch (e) {
        reason = `check crashed: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!reason) continue;
      c.failed.set(check.name, (c.failed.get(check.name) ?? 0) + 1);
      failures.push({ task: row.task, check: check.name, id: row.id, at: row.created_at, reason });
    }
  }
  return { failures, counts };
}
