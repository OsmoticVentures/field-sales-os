/**
 * Rewrite the pending email drafts under today's rules: a day and a time from
 * his next days near the account, the lessons he has taught since, the core
 * sheets. Juan, 2026-11-12: "clear the outbound backlog ... drafts more useful
 * so I can send more and quicker".
 *
 *   npx tsx --conditions=react-server scripts/refresh-pending.ts --dry [id ...]
 *   npx tsx --conditions=react-server scripts/refresh-pending.ts [id ...]
 *
 * Sources are the account's own last notes plus the row's ask, exactly as a new
 * draft's are; the old draft is shown to the model for who and what, never as a
 * source, so the number check refuses anything only the old draft said. A draft
 * that still names a day already past is refused here, and a refused one stays
 * as it was.
 *
 * A rewritten row that is already in Outlook Drafts is queued in REPLACE for
 * bridges/nutribiotic/order_watch.py, which swaps the Outlook copy in its warm
 * session, unless he edited that copy by hand (his edit wins). Entries leave
 * REPLACE when swapped or dropped: the file holds at most the pending backlog.
 *
 * Needs NB_SUPABASE_* and NB_AI_CLI=1 (the Max plan), as draft-from-visits.ts.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadAskInputs } from "../src/lib/features/outbound/actions";
import { composeAsk } from "../src/lib/features/outbound/compose";
import { laDay } from "../src/lib/core/once-server";

process.env.NB_SCRIPT_USER ??= "juan";
const SB_URL = process.env.NB_SUPABASE_URL!;
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY!;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };
const REPLACE = `${process.env.HOME}/agency/bridges/nutribiotic/.outlook-replace.json`;

type Row = {
  id: string;
  account_id: string | null;
  play_key: string | null;
  subject: string | null;
  body_md: string;
  to_email: string | null;
  to_name: string | null;
  source_ask: string | null;
  provider_msg_id: string | null;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!res.ok) throw new Error(`${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A month-and-day the email proposes that is today or earlier ("Tuesday, Nov 3"). */
export function pastDay(body: string, today: string): string | null {
  const [y, m, d] = today.split("-").map(Number);
  for (const hit of body.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)) {
    const mon = MONTHS.indexOf(hit[1].toLowerCase()) + 1;
    const day = Number(hit[2]);
    // A month more than two back is next year's ("Jan 5" written in November).
    const year = mon < m - 2 ? y + 1 : y;
    if (year * 10000 + mon * 100 + day <= y * 10000 + m * 100 + d) return hit[0];
  }
  return null;
}

async function refresh(r: Row, today: string, dry: boolean, replace: Record<string, unknown>) {
  if (!r.account_id) return "skipped: no account";
  const { account, contacts, voice } = await loadAskInputs(r.account_id);
  if (!account) return "skipped: not in this rep's book";
  const notes = await get<{ raw_text: string; created_at: string }[]>(
    `nb_touchpoints?select=raw_text,created_at&account_id=eq.${r.account_id}&order=created_at.desc&limit=3`,
  );
  // Older visits live only in the activity log (HubSpot-era meetings and calls), never enrichment rows.
  const acts = notes.length
    ? []
    : await get<{ at: string; detail: string | null }[]>(
        `nb_activities?select=at,detail&account_id=eq.${r.account_id}&kind=in.(meeting,call)&detail=not.is.null&order=at.desc&limit=3`,
      );
  const lines = [
    ...notes.map((n) => `NOTE ${n.created_at.slice(0, 10)}: ${n.raw_text}`),
    ...acts.map((a) => `NOTE ${a.at.slice(0, 10)}: ${a.detail}`),
  ];
  if (!lines.length && !r.source_ask) return "skipped: no note on file to write from";
  const composed = await composeAsk({
    ask: r.source_ask ?? r.subject ?? "",
    noteText: lines.join("\n\n"),
    account: { id: account.id, name: account.name, city: account.city, email: account.email },
    contacts,
    voice,
    reference: { body: r.body_md, today },
  });
  if (!composed.written) return `kept as it was: ${composed.reason}`;
  const stale = pastDay(`${composed.subject}\n${composed.body}`, today);
  if (stale) return `kept as it was: the rewrite still proposes ${stale}, which has passed`;
  if (dry) return `WOULD WRITE\nSubject: ${composed.subject}\n${composed.body}`;

  const patch: Record<string, string | null> = { subject: composed.subject, body_md: composed.body };
  if (!r.to_email && composed.toEmail) {
    patch.to_email = composed.toEmail;
    patch.to_name = composed.toName;
    patch.contact_id = composed.contactId;
  }
  const res = await fetch(`${SB_URL}/rest/v1/nb_outbound_drafts?id=eq.${r.id}&status=eq.pending`, {
    method: "PATCH",
    headers: { ...H, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return `not saved: ${res.status} ${await res.text()}`;
  const item = r.provider_msg_id?.match(/^outlook-draft:(.+)$/)?.[1];
  if (item) replace[r.id] = { item, old_subject: r.subject, old_body: r.body_md };
  return `rewritten: ${composed.subject}`;
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const ids = args.filter((a) => !a.startsWith("--"));
  const today = laDay();
  const rows = await get<Row[]>(
    "nb_outbound_drafts?select=id,account_id,play_key,subject,body_md,to_email,to_name,source_ask,provider_msg_id" +
      `&status=eq.pending&channel=eq.email&order=created_at.asc${ids.length ? `&id=in.(${ids.join(",")})` : ""}`,
  );
  const replace: Record<string, unknown> = existsSync(REPLACE) ? JSON.parse(readFileSync(REPLACE, "utf8")) : {};
  for (const r of rows) {
    let out: string;
    try {
      out = await refresh(r, today, dry, replace);
    } catch (e) {
      out = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    console.log(`\n=== ${r.id} · ${r.to_email ?? "(no address)"} · ${r.subject}\n${out}`);
    if (!dry) writeFileSync(REPLACE, JSON.stringify(replace, null, 1));
  }
}

if (process.argv[1]?.endsWith("refresh-pending.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
