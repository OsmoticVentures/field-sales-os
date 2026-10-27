/**
 * The Prospect dashboard's intelligence read: one answer per rep, built from
 * what the agency already has (nb_accounts, its enrichment ledger, the
 * effective activity view, the SDR queue, outbound drafts, the cadence view,
 * the priority book) and the playbook outline generated from the agency repo.
 *
 * Every number traces to one of those reads. A panel with nothing behind it
 * comes back empty, and the screen leaves it out; nothing here is a target,
 * an estimate or a placeholder.
 *
 * COST (AGENTS.md P9). The priority book is shared with the rest of the app
 * and kept ten minutes per server (dal.ts). On top of it this reads the
 * rep's open accounts (named columns and four enrichment paths, not the
 * ledger), 120 days of touches by id, the pending queue rows, and the
 * cadence view for the ranked accounts only. The built answer is kept five
 * minutes per rep per server, and the phone keeps the last one (api.ts), so
 * opening the screen paints at once and asks again only underneath.
 */
import "server-only";
import { createHash } from "node:crypto";
import { currentUser } from "../../core/user";
import { getPriorityBook, isConfigured, sbGet, sbGetAllIn, sbWrite, todayStartLA } from "./dal";
import { PLAYBOOK_SECTIONS, type PlaybookSection } from "./playbook.generated";

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export type IntelChannel = {
  key: "in_person" | "call" | "email" | "text" | "linkedin" | "sample";
  label: string;
  week: number;
  prevWeek: number;
  /** Touches per day, oldest first, the last 14 LA days ending today. */
  days: number[];
};

export type IntelFollowup = {
  id: string;
  accountId: string | null;
  name: string;
  kind: "call" | "visit" | "email" | "callback";
  why: string;
  /** YYYY-MM-DD it was due. */
  due: string;
  overdueDays: number;
};

export type IntelSequence = {
  accountId: string;
  name: string;
  steps: { kind: IntelChannel["key"]; at: string }[];
  next: { kind: "call" | "visit" | "callback"; date: string } | null;
  daysSinceLast: number;
};

export type IntelRanked = { id: string; name: string; area: string | null; score: number | null; reason: string; band: string };

export type IntelSocial = { id: string; name: string; instagram: string | null; facebook: string | null; linkedin: string | null };

export type IntelLead = { id: string; name: string; grade: string | null; business: string | null; city: string | null; at: string };

export type IntelPayload = {
  ok: true;
  builtAt: string;
  summary: { text: string; at: string } | null;
  pulse: {
    touchesWeek: number;
    touchesPrevWeek: number;
    followupsDue: number;
    newLeads14: number;
    rankedNow: number;
  };
  channels: IntelChannel[];
  draftsPending: number;
  followups: IntelFollowup[];
  sequences: IntelSequence[];
  ranked: IntelRanked[];
  socials: { book: number; instagram: number; facebook: number; linkedin: number; top: IntelSocial[] };
  scan: {
    lastScanAt: string | null;
    new14: { source: string; count: number }[];
    scoutGrades: { grade: string; count: number }[];
    dormantFit: { good: number; notFit: number };
    fitScored: number;
    awaitingFirstTouch: IntelLead[];
  };
  playbook: {
    sections: PlaybookSection[];
    tested: number;
    storeTypes: { type: string; accounts: number; conversations: number }[];
    conversations30: number;
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

function laIso(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T12:00:00Z`) - Date.parse(`${fromIso}T12:00:00Z`)) / DAY);
}

const CHANNEL_OF: Record<string, IntelChannel["key"]> = {
  visit: "in_person",
  meeting: "in_person",
  staff_training: "in_person",
  call: "call",
  email_out: "email",
  text: "text",
  linkedin: "linkedin",
  sample_drop: "sample",
};
const CHANNEL_LABEL: Record<IntelChannel["key"], string> = {
  in_person: "In person",
  call: "Calls",
  email: "Email",
  text: "Texts",
  linkedin: "LinkedIn",
  sample: "Samples",
};
const OUTBOUND_KINDS = Object.keys(CHANNEL_OF);

const SOURCE_LABEL: Record<string, string> = {
  lead_scout: "Lead scout",
  nb_places_search: "Places search",
};

const STORE_LABEL: Record<string, string> = {
  natural_grocery: "Natural grocery",
  supplement_store: "Supplement store",
  health_food_store: "Health food store",
  pharmacy: "Pharmacy",
  practice: "Practice",
  clinic: "Clinic",
  gym: "Gym",
  general_grocery: "General grocery",
  grocery: "Grocery",
};
function storeLabel(t: string): string {
  return STORE_LABEL[t] ?? t.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

type AccountRow = {
  id: string;
  name: string;
  city: string | null;
  store_type: string | null;
  source: string | null;
  created_at: string;
  instagram_url: string | null;
  facebook_url: string | null;
  linkedin_url: string | null;
  ls_at: string | null;
  ls_grade: string | null;
  ls_business: string | null;
  pf_at: string | null;
  df_at: string | null;
  df_verdict: string | null;
};

type TouchRow = { account_id: string; at: string; effective_kind: string };

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const TTL_MS = 5 * 60 * 1000;
const memos = new Map<string, { at: number; p: Promise<IntelPayload> }>();

export function invalidateIntel(): void {
  memos.clear();
}

export async function getIntel(): Promise<IntelPayload> {
  const me = await currentUser();
  const hit = memos.get(me.id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.p;
  const memo = { at: Date.now(), p: buildIntel(me.id, me.ownerId) };
  memos.set(me.id, memo);
  memo.p.catch(() => {
    if (memos.get(me.id) === memo) memos.delete(me.id);
  });
  return memo.p;
}

async function buildIntel(repId: string, ownerId: string): Promise<IntelPayload> {
  const now = new Date();
  const today = todayStartLA().slice(0, 10);
  const empty: IntelPayload = {
    ok: true,
    builtAt: now.toISOString(),
    summary: null,
    pulse: { touchesWeek: 0, touchesPrevWeek: 0, followupsDue: 0, newLeads14: 0, rankedNow: 0 },
    channels: [],
    draftsPending: 0,
    followups: [],
    sequences: [],
    ranked: [],
    socials: { book: 0, instagram: 0, facebook: 0, linkedin: 0, top: [] },
    scan: { lastScanAt: null, new14: [], scoutGrades: [], dormantFit: { good: 0, notFit: 0 }, fitScored: 0, awaitingFirstTouch: [] },
    playbook: { sections: PLAYBOOK_SECTIONS, tested: PLAYBOOK_SECTIONS.filter((s) => s.status === "tested").length, storeTypes: [], conversations30: 0 },
  };
  if (!isConfigured()) return empty;

  const [book, accounts] = await Promise.all([
    getPriorityBook(),
    readAll<AccountRow>(
      "nb_accounts",
      new URLSearchParams({
        select: [
          "id,name,city,store_type,source,created_at,instagram_url,facebook_url,linkedin_url",
          "ls_at:enrichment_status->lead_scout->>at",
          "ls_grade:enrichment_status->lead_scout->>grade",
          "ls_business:enrichment_status->lead_scout->>main_business",
          "pf_at:enrichment_status->prospect_fit->>at",
          "df_at:enrichment_status->dormant_fit->>at",
          "df_verdict:enrichment_status->dormant_fit->>verdict",
        ].join(","),
        hubspot_owner_id: `eq.${ownerId}`,
        closed_at: "is.null",
        lifecycle: "neq.waypoint",
        chain_excluded: "eq.false",
        order: "id.asc",
      }),
    ),
  ]);
  const ids = accounts.map((a) => a.id);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  if (ids.length === 0) return empty;

  const since = laIso(new Date(now.getTime() - 120 * DAY));
  const rankedTop = book.ranked.slice(0, 60);
  const [touches, queue, drafts, cadence] = await Promise.all([
    sbGetAllIn<TouchRow>(
      "nb_v_activities_effective",
      new URLSearchParams({
        select: "account_id,at,effective_kind",
        retracted: "is.false",
        effective_kind: `in.(${OUTBOUND_KINDS.join(",")})`,
        at: `gte.${since}`,
        order: "at.asc",
      }),
      "account_id",
      ids,
    ),
    sbGet<{ id: string; account_id: string | null; prospect_name: string | null; kind: "call" | "visit"; scheduled_date: string; notes: string | null }>(
      "nb_sdr_schedule",
      new URLSearchParams({ select: "id,account_id,prospect_name,kind,scheduled_date,notes", status: "eq.pending", order: "scheduled_date.asc", limit: "300" }),
    ),
    sbGetAllIn<{ id: string; account_id: string; callback_on: string | null; urgency_reason: string | null; subject: string | null }>(
      "nb_outbound_drafts",
      new URLSearchParams({ select: "id,account_id,callback_on,urgency_reason,subject", status: "eq.pending" }),
      "account_id",
      ids,
    ),
    rankedTop.length
      ? sbGetAllIn<{ account_id: string; name: string; tier: string | null; visit_days_overdue: number | null; never_visited: boolean | null }>(
          "nb_v_cadence_due",
          new URLSearchParams({ select: "account_id,name,tier,visit_days_overdue,never_visited", visit_days_overdue: "gt.0" }),
          "account_id",
          rankedTop.map((r) => r.account.id),
        )
      : Promise.resolve([]),
  ]);

  // ---- channels: 14 LA days of touches by channel
  const dayKeys: string[] = [];
  for (let i = 13; i >= 0; i--) dayKeys.push(laIso(new Date(now.getTime() - i * DAY)));
  const dayIdx = new Map(dayKeys.map((d, i) => [d, i]));
  const chan = new Map<IntelChannel["key"], number[]>();
  for (const t of touches) {
    const key = CHANNEL_OF[t.effective_kind];
    const i = dayIdx.get(laIso(new Date(t.at)));
    if (!key || i === undefined) continue;
    if (!chan.has(key)) chan.set(key, new Array(14).fill(0));
    chan.get(key)![i]++;
  }
  const channels: IntelChannel[] = (Object.keys(CHANNEL_LABEL) as IntelChannel["key"][])
    .filter((k) => chan.has(k))
    .map((k) => {
      const days = chan.get(k)!;
      return { key: k, label: CHANNEL_LABEL[k], days, week: sum(days.slice(7)), prevWeek: sum(days.slice(0, 7)) };
    })
    .sort((a, b) => b.week + b.prevWeek - (a.week + a.prevWeek));

  // ---- follow-ups: the queue due by today, callbacks due within three days,
  // and ranked accounts past their own visit cadence.
  const followups: IntelFollowup[] = [];
  const mineQueue = queue.filter((q) => (q.account_id ? byId.has(q.account_id) : repId === "juan"));
  // A queue row left pending for weeks is a list nobody worked, not a
  // follow-up: the panel takes the last two weeks of the queue.
  const queueFrom = laIso(new Date(now.getTime() - 14 * DAY));
  for (const q of mineQueue) {
    if (q.scheduled_date > today || q.scheduled_date < queueFrom) continue;
    followups.push({
      id: `q:${q.id}`,
      accountId: q.account_id,
      name: (q.account_id && byId.get(q.account_id)?.name) || q.prospect_name || "Unnamed",
      kind: q.kind,
      why: q.notes?.trim() || (q.kind === "call" ? "Scheduled call" : "Scheduled visit"),
      due: q.scheduled_date,
      overdueDays: Math.max(0, daysBetween(q.scheduled_date, today)),
    });
  }
  const soon = laIso(new Date(now.getTime() + 3 * DAY));
  for (const d of drafts) {
    if (!d.callback_on || d.callback_on > soon) continue;
    followups.push({
      id: `d:${d.id}`,
      accountId: d.account_id,
      name: byId.get(d.account_id)?.name ?? "Unnamed",
      kind: "callback",
      why: d.urgency_reason?.trim() || d.subject?.trim() || "Callback",
      due: d.callback_on,
      overdueDays: Math.max(0, daysBetween(d.callback_on, today)),
    });
  }
  const tierRank: Record<string, number> = { AA: 0, A: 1, B: 2, C: 3, D: 4, E: 5 };
  const cadenceRows = [...cadence]
    .sort((a, b) => (tierRank[a.tier ?? ""] ?? 9) - (tierRank[b.tier ?? ""] ?? 9) || (b.visit_days_overdue ?? 0) - (a.visit_days_overdue ?? 0))
    .slice(0, 8);
  for (const c of cadenceRows) {
    if (followups.some((f) => f.accountId === c.account_id)) continue;
    const overdue = c.visit_days_overdue ?? 0;
    followups.push({
      id: `c:${c.account_id}`,
      accountId: c.account_id,
      name: c.name,
      kind: "visit",
      why: c.tier ? `Tier ${c.tier}, past its visit cadence` : "Past its visit cadence",
      due: laIso(new Date(now.getTime() - overdue * DAY)),
      overdueDays: overdue,
    });
  }
  followups.sort((a, b) => b.overdueDays - a.overdueDays || a.name.localeCompare(b.name));

  // ---- sequences: accounts with two or more touches in 30 days, their chain
  // of touches in order, and the next step already on the books.
  const cut30 = new Date(now.getTime() - 30 * DAY).toISOString();
  const chains = new Map<string, { kind: IntelChannel["key"]; at: string }[]>();
  for (const t of touches) {
    if (t.at < cut30) continue;
    const key = CHANNEL_OF[t.effective_kind];
    if (!key) continue;
    if (!chains.has(t.account_id)) chains.set(t.account_id, []);
    chains.get(t.account_id)!.push({ kind: key, at: t.at });
  }
  const nextFor = (accountId: string): IntelSequence["next"] => {
    const q = mineQueue.find((r) => r.account_id === accountId && r.scheduled_date >= today);
    const d = drafts.filter((r) => r.account_id === accountId && r.callback_on && r.callback_on >= today).sort((a, b) => a.callback_on!.localeCompare(b.callback_on!))[0];
    if (q && (!d || q.scheduled_date <= d.callback_on!)) return { kind: q.kind, date: q.scheduled_date };
    if (d) return { kind: "callback", date: d.callback_on! };
    return null;
  };
  const sequences: IntelSequence[] = [...chains.entries()]
    .filter(([, steps]) => steps.length >= 2)
    .map(([accountId, steps]) => {
      const last = steps[steps.length - 1].at;
      return {
        accountId,
        name: byId.get(accountId)?.name ?? "Unnamed",
        steps: steps.slice(-6),
        next: nextFor(accountId),
        daysSinceLast: Math.max(0, daysBetween(laIso(new Date(last)), today)),
      };
    })
    .sort((a, b) => a.daysSinceLast - b.daysSinceLast)
    .slice(0, 12);

  // ---- ranked: the book's order, top 25
  const ranked: IntelRanked[] = book.ranked.slice(0, 25).map((r) => ({
    id: r.account.id,
    name: r.account.name,
    area: r.account.area ?? null,
    score: r.result.score,
    reason: r.result.reason,
    band: r.result.band,
  }));
  const rankedNow = book.ranked.filter((r) => r.result.band === "now").length;

  // ---- socials: coverage across the open book, and the ranked accounts that
  // have one, in ranked order
  const socials = {
    book: accounts.length,
    instagram: accounts.filter((a) => a.instagram_url).length,
    facebook: accounts.filter((a) => a.facebook_url).length,
    linkedin: accounts.filter((a) => a.linkedin_url).length,
    top: book.ranked
      .map((r) => byId.get(r.account.id))
      .filter((a): a is AccountRow => Boolean(a && (a.instagram_url || a.facebook_url || a.linkedin_url)))
      .slice(0, 10)
      .map((a) => ({ id: a.id, name: a.name, instagram: a.instagram_url, facebook: a.facebook_url, linkedin: a.linkedin_url })),
  };

  // ---- scan and qualification
  const cut14 = new Date(now.getTime() - 14 * DAY).toISOString();
  const new14 = countBy(accounts.filter((a) => a.created_at >= cut14), (a) => SOURCE_LABEL[a.source ?? ""] ?? "By hand")
    .map(([source, count]) => ({ source, count }));
  const scanStamps = accounts.flatMap((a) => [a.ls_at, a.pf_at, a.df_at]).filter((v): v is string => Boolean(v));
  const touched = new Set(touches.map((t) => t.account_id));
  const scoutGrades = countBy(accounts.filter((a) => a.ls_grade), (a) => a.ls_grade!)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([grade, count]) => ({ grade, count }));
  const gradeOrder = (g: string | null) => (g ? "AABCDEFG".indexOf(g) : 99);
  const awaitingFirstTouch: IntelLead[] = accounts
    .filter((a) => a.ls_at && !touched.has(a.id))
    .sort((a, b) => gradeOrder(a.ls_grade) - gradeOrder(b.ls_grade) || (b.ls_at ?? "").localeCompare(a.ls_at ?? ""))
    .slice(0, 8)
    .map((a) => ({ id: a.id, name: a.name, grade: a.ls_grade, business: a.ls_business ? storeLabel(a.ls_business) : null, city: a.city, at: a.ls_at! }));
  const scan = {
    lastScanAt: scanStamps.length ? scanStamps.reduce((m, v) => (v > m ? v : m)) : null,
    new14,
    scoutGrades,
    dormantFit: {
      good: accounts.filter((a) => a.df_verdict === "good_fit").length,
      notFit: accounts.filter((a) => a.df_verdict === "not_fit").length,
    },
    fitScored: accounts.filter((a) => a.pf_at).length,
    awaitingFirstTouch,
  };

  // ---- playbook: what the field has gathered toward the sections still open
  const inPerson = touches.filter((t) => CHANNEL_OF[t.effective_kind] === "in_person");
  const typeAgg = new Map<string, { accounts: Set<string>; conversations: number }>();
  for (const t of inPerson) {
    const type = byId.get(t.account_id)?.store_type;
    if (!type) continue;
    if (!typeAgg.has(type)) typeAgg.set(type, { accounts: new Set(), conversations: 0 });
    const g = typeAgg.get(type)!;
    g.accounts.add(t.account_id);
    g.conversations++;
  }
  const storeTypes = [...typeAgg.entries()]
    .map(([type, g]) => ({ type: storeLabel(type), accounts: g.accounts.size, conversations: g.conversations }))
    .sort((a, b) => b.conversations - a.conversations)
    .slice(0, 6);
  const conversations30 = inPerson.filter((t) => t.at >= cut30).length + touches.filter((t) => t.at >= cut30 && t.effective_kind === "call").length;

  const weekTouches = sum(channels.map((c) => c.week));
  const prevTouches = sum(channels.map((c) => c.prevWeek));
  const payload: IntelPayload = {
    ok: true,
    builtAt: now.toISOString(),
    summary: null,
    pulse: {
      touchesWeek: weekTouches,
      touchesPrevWeek: prevTouches,
      followupsDue: followups.length,
      newLeads14: sum(new14.map((n) => n.count)),
      rankedNow,
    },
    channels,
    draftsPending: drafts.length,
    followups: followups.slice(0, 12),
    sequences,
    ranked,
    socials,
    scan,
    playbook: { ...empty.playbook, storeTypes, conversations30 },
  };
  payload.summary = await readSummary(repId);
  return payload;
}

async function readAll<T>(table: string, params: URLSearchParams): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += 1000) {
    const p = new URLSearchParams(params);
    p.set("limit", "1000");
    p.set("offset", String(offset));
    const page = await sbGet<T>(table, p);
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

function countBy<T>(xs: T[], key: (x: T) => string): [string, number][] {
  const m = new Map<string, number>();
  for (const x of xs) {
    const k = key(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// The summary: a short read of the facts above, written by a model once the
// facts move, kept in nb_config (one row per rep, rewritten in place). The
// screen never waits on it: it shows the last one written, and a new one is
// written after the response when the facts have changed.
// ---------------------------------------------------------------------------

const SUMMARY_KEY = (rep: string) => `prospect_intel_summary:${rep}`;
/** At most one rewrite per rep in this window, however often the facts move. */
const SUMMARY_MIN_AGE_MS = 3 * 60 * 60 * 1000;

type StoredSummary = { text: string; at: string; facts_hash: string };

/** The facts a summary is written from, and nothing else. */
export function summaryFacts(p: IntelPayload) {
  return {
    touches_this_week: p.pulse.touchesWeek,
    touches_last_week: p.pulse.touchesPrevWeek,
    by_channel_this_week: Object.fromEntries(p.channels.map((c) => [c.label, c.week])),
    followups_due: p.followups.slice(0, 5).map((f) => ({ account: f.name, kind: f.kind, overdue_days: f.overdueDays })),
    followups_due_total: p.pulse.followupsDue,
    accounts_in_motion: p.sequences.length,
    top_ranked: p.ranked.slice(0, 3).map((r) => ({ account: r.name, why: r.reason })),
    new_leads_14_days: p.pulse.newLeads14,
    scouted_awaiting_first_touch: p.scan.awaitingFirstTouch.slice(0, 3).map((l) => ({ account: l.name, grade: l.grade })),
    playbook_sections_open: p.playbook.sections.filter((s) => s.status !== "tested").map((s) => s.title),
  };
}

export function factsHash(p: IntelPayload): string {
  return createHash("sha256").update(JSON.stringify(summaryFacts(p))).digest("hex").slice(0, 16);
}

const cachedSummaries = new Map<string, StoredSummary>();

async function readSummary(repId: string): Promise<IntelPayload["summary"]> {
  try {
    const rows = await sbGet<{ value: StoredSummary }>("nb_config", new URLSearchParams({ select: "value", key: `eq.${SUMMARY_KEY(repId)}`, limit: "1" }));
    const v = rows[0]?.value;
    if (v?.text) cachedSummaries.set(repId, v);
    return v?.text ? { text: v.text, at: v.at } : null;
  } catch {
    const v = cachedSummaries.get(repId);
    return v ? { text: v.text, at: v.at } : null;
  }
}

/** Should a new summary be written for these facts? */
const summaryTried = new Map<string, number>();
/** A failed or refused write is not retried on every open: one try per rep
 *  per ten minutes per server. */
const SUMMARY_RETRY_MS = 10 * 60 * 1000;

export function summaryStale(repId: string, p: IntelPayload): boolean {
  const tried = summaryTried.get(repId) ?? 0;
  if (Date.now() - tried < SUMMARY_RETRY_MS) return false;
  const stale = summaryNeeded(repId, p);
  if (stale) summaryTried.set(repId, Date.now());
  return stale;
}

function summaryNeeded(repId: string, p: IntelPayload): boolean {
  const v = cachedSummaries.get(repId);
  if (!v) return true;
  if (v.facts_hash === factsHash(p)) return false;
  return Date.now() - Date.parse(v.at) > SUMMARY_MIN_AGE_MS;
}

/** Every number the summary states must be one the facts state. */
export function numbersTraced(text: string, facts: unknown): boolean {
  const have = new Set((JSON.stringify(facts).match(/\d+/g) ?? []).map(String));
  return (text.match(/\d+/g) ?? []).every((n) => have.has(n));
}

export async function storeSummary(repId: string, p: IntelPayload, text: string): Promise<void> {
  const value: StoredSummary = { text, at: new Date().toISOString(), facts_hash: factsHash(p) };
  const row = { value, source: "clientos:prospect-intel", content_hash: value.facts_hash, published_at: value.at };
  // One row per rep, rewritten in place: update it, or write it the first time.
  const updated = await sbWrite("nb_config", "PATCH", row, new URLSearchParams({ key: `eq.${SUMMARY_KEY(repId)}` }));
  if (updated.length === 0) await sbWrite("nb_config", "POST", { key: SUMMARY_KEY(repId), ...row });
  cachedSummaries.set(repId, value);
  invalidateIntel();
}
