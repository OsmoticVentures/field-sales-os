/**
 * Data access for Outbound (/outbound): nb_outbound_drafts, plus the
 * voice_lessons/voice_pairs tables compose.ts reads for context. Same
 * Supabase project and same tables the NutriBiotic OS's lib/dal.ts reads
 * (insertAskDraft, listAskKeys, getVoiceContext, listDrafts, setDraftStatus),
 * ported as a feature-local slice per PORTING.md: only what this feature's
 * screens and routes actually call, direct-to-Supabase-REST, same pattern
 * as lib/features/prospect/dal.ts.
 */
import "server-only";
import { ASK_COMPOSED_PLAY, ASK_UNWRITTEN_PLAY, normalizeAsk, unwrittenBody, type ComposedAsk } from "./compose";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

export const isConfigured = (): boolean => Boolean(SB_URL && SB_KEY);

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw err instanceof Error && err.name === "AbortError"
      ? new Error(`Request to ${url} timed out after ${timeoutMs}ms.`)
      : err;
  } finally {
    clearTimeout(timer);
  }
}

async function sbGet<T>(table: string, params: URLSearchParams): Promise<T[]> {
  if (!isConfigured()) return [];
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}?${params}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Supabase ${table} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T[];
}

async function sbWrite<T>(table: string, method: "POST" | "PATCH", body: unknown, params?: URLSearchParams): Promise<T[]> {
  if (!isConfigured()) throw new Error(`Cannot write to "${table}": no data source configured.`);
  const qs = params ? `?${params}` : "";
  const res = await fetchWithTimeout(`${SB_URL}/rest/v1/${table}${qs}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${table} ${method} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T[]) : [];
}

/** Our id shape throughout this schema: '<prefix>_<6 hex>'. */
function randId(prefix: string): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export type Draft = {
  id: string;
  account_id: string | null;
  contact_id: string | null;
  channel: string;
  subject: string | null;
  body_md: string;
  to_email: string | null;
  to_name: string | null;
  bcc_email: string | null;
  play_key: string | null;
  source_ask: string | null;
  status: string;
  created_at: string;
  urgency: number | null;
  urgency_reason: string | null;
  preferred_channel: "email" | "whatsapp" | "imessage" | null;
};

/**
 * The pending queue, most urgent first. Sort happens on the rows already
 * held rather than in the PostgREST `order`, same reasoning as the source's
 * listDrafts: an ungraded draft (urgency null) sorts below "low" rather than
 * being treated as "no hurry".
 */
export async function listPendingDrafts(limit = 100): Promise<Draft[]> {
  const rows = await sbGet<Draft>(
    "nb_outbound_drafts",
    new URLSearchParams({ select: "*", status: "eq.pending", order: "created_at.desc", limit: String(limit) }),
  );
  const rank = (d: Draft) => (typeof d.urgency === "number" ? d.urgency : -1);
  return [...rows].sort((a, b) => rank(b) - rank(a));
}

/**
 * Every ask already filed for one account, whatever became of it, read
 * across every status on purpose. A sent ask is done and a dismissed ask
 * was refused; proposing either one again is what this read exists to
 * prevent.
 */
export async function listAskKeys(accountId: string): Promise<{ id: string; source_ask: string; status: string }[]> {
  const rows = await sbGet<{ id: string; source_ask: string | null; status: string }>(
    "nb_outbound_drafts",
    new URLSearchParams({ select: "id,source_ask,status", account_id: `eq.${accountId}`, source_ask: "not.is.null", limit: "200" }),
  );
  return rows.filter((r): r is { id: string; source_ask: string; status: string } => Boolean(r.source_ask));
}

/**
 * What Juan's own rewrites teach the composer: lessons seen at least twice
 * (a pattern, not a one-off) and the two closest draft-vs-sent pairs, this
 * account's first, then the most recent. A read that fails returns nothing;
 * composing never waits on this.
 */
export async function getVoiceContext(accountId: string): Promise<{
  lessons: { lesson: string; before: string | null; after: string | null; seen: number }[];
  pairs: { draft: string; sent: string }[];
}> {
  try {
    type L = { lesson: string; before_quote: string | null; after_quote: string | null; seen_count: number };
    type P = { draft: string; sent: string; account_id: string | null };
    const [lessons, own, recent] = await Promise.all([
      sbGet<L>(
        "voice_lessons",
        new URLSearchParams({ select: "lesson,before_quote,after_quote,seen_count", seen_count: "gte.2", order: "seen_count.desc,last_seen.desc", limit: "12" }),
      ),
      sbGet<P>("voice_pairs", new URLSearchParams({ select: "draft,sent,account_id", account_id: `eq.${accountId}`, order: "sent_at.desc", limit: "2" })),
      sbGet<P>("voice_pairs", new URLSearchParams({ select: "draft,sent,account_id", order: "sent_at.desc", limit: "4" })),
    ]);
    const pairs = [...own, ...recent.filter((r) => r.account_id !== accountId)].slice(0, 2);
    return {
      lessons: lessons.map((l) => ({ lesson: l.lesson, before: l.before_quote, after: l.after_quote, seen: l.seen_count })),
      pairs: pairs.map((p) => ({ draft: p.draft, sent: p.sent })),
    };
  } catch {
    return { lessons: [], pairs: [] };
  }
}

/**
 * File one thing to say to an account, as an email that can be sent. The
 * composition already happened (compose.ts's composeAsk); this only writes
 * the row, in the composed form when it was written, or in the source's own
 * unwritten form (the ask, then the reason) when it was refused.
 */
export async function insertAskDraft(input: { account_id: string; ask: string; composed: ComposedAsk }): Promise<Draft> {
  const c = input.composed;
  const [row] = await sbWrite<Draft>("nb_outbound_drafts", "POST", {
    id: randId("draft"),
    account_id: input.account_id,
    contact_id: c.written ? c.contactId : null,
    channel: "email",
    subject: c.written ? c.subject : null,
    body_md: c.written ? c.body : unwrittenBody(input.ask, c.reason),
    to_email: c.written ? c.toEmail : null,
    to_name: c.written ? c.toName : null,
    bcc_email: null,
    play_key: c.written ? ASK_COMPOSED_PLAY : ASK_UNWRITTEN_PLAY,
    source_ask: normalizeAsk(input.ask),
    campaign_id: null,
    status: "pending",
    origin: "manual",
  });
  return row;
}

/**
 * Juan clicked the compose link (or is dismissing a draft he will not
 * send). "sent" is self-reported: this mailbox holds no Mail.Send scope, so
 * the OS cannot verify a send. It only records that Juan says he did.
 */
export async function setDraftStatus(id: string, status: "sent" | "dismissed"): Promise<Draft> {
  const patch: Record<string, unknown> = { status };
  if (status === "sent") patch.sent_at = new Date().toISOString();
  const [row] = await sbWrite<Draft>("nb_outbound_drafts", "PATCH", patch, new URLSearchParams({ id: `eq.${id}` }));
  return row;
}
