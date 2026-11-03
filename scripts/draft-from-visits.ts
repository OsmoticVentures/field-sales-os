/**
 * Run the visit email trigger over touchpoints already filed. Same function
 * the Visit screen's filing calls, same once-per-touchpoint guard.
 *
 *   npx tsx --conditions=react-server scripts/draft-from-visits.ts t_abc t_def
 *   npx tsx --conditions=react-server scripts/draft-from-visits.ts --sweep
 *
 * --sweep is the periodic check (bridges/nutribiotic/follow_through_cron.sh,
 * every 30 minutes). Over the last SWEEP_DAYS of customer notes it retries:
 *   - a note the trigger never finished (no stored outcome, e.g. the filing
 *     timed out), and
 *   - a note decided "nothing owed" while someone in it handed over an email
 *     address and the account has no draft since the note.
 * A refusal is not stored by draftFromVisit, so each note gets at most
 * MAX_TRIES sweep attempts, counted in STATE (pruned past SWEEP_DAYS).
 *
 * Needs NB_SUPABASE_* and ANTHROPIC_API_KEY in the env. Runs as rep
 * NB_SCRIPT_USER (default "juan"), so it drafts for that rep's book only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { draftFromVisit, givenEmails } from "../src/lib/features/outbound/from-visit";

process.env.NB_SCRIPT_USER ??= "juan";
const SB_URL = process.env.NB_SUPABASE_URL!;
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY!;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

const SWEEP_DAYS = 3;
const MAX_TRIES = 3;
const STATE = process.env.VISIT_SWEEP_STATE ?? `${process.env.HOME}/agency/bridges/nutribiotic/.visit-draft-sweep.json`;

type Person = { first_name?: string | null; last_name?: string | null; email?: string | null };
type Parsed = {
  activity?: { kind?: string };
  next_step?: string | null;
  outreach_asks?: { ask: string }[];
  people?: Person[];
};
type Tp = { id: string; account_id: string | null; raw_text: string; parsed: Parsed | null; created_at: string };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: H });
  if (!res.ok) throw new Error(`${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function draft(tp: Tp) {
  if (!tp.account_id || !tp.parsed) return { status: "skipped: no account or parse" };
  return draftFromVisit({
    touchpointId: tp.id,
    accountId: tp.account_id,
    rawText: tp.raw_text,
    kind: tp.parsed.activity?.kind ?? "visit",
    nextStep: tp.parsed.next_step ?? null,
    outreachAsks: (tp.parsed.outreach_asks ?? []).map((a) => a.ask).filter(Boolean),
    givenEmails: givenEmails(tp.raw_text, tp.parsed.people),
  });
}

async function byIds(ids: string[]) {
  const rows = await get<Tp[]>(`nb_touchpoints?select=id,account_id,raw_text,parsed,created_at&id=in.(${ids.join(",")})`);
  for (const tp of rows) console.log(tp.id, JSON.stringify(await draft(tp)));
}

async function sweep() {
  const since = new Date(Date.now() - SWEEP_DAYS * 864e5).toISOString();
  // Ids first: most runs end here for a few hundred bytes (root P9).
  const recent = await get<{ id: string }[]>(
    `nb_touchpoints?select=id&account_id=not.is.null&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=200`,
  );
  if (!recent.length) return console.log("sweep: no notes");
  const keys = await get<{ id: string; response: { status?: string } | null }[]>(
    `nb_idempotency_keys?select=id,response&id=in.(${recent.map((r) => `outbound:visit:${r.id}`).join(",")})`,
  );
  const outcome = new Map(keys.map((k) => [k.id.slice("outbound:visit:".length), k.response?.status ?? null]));
  const open = recent.filter((r) => !outcome.has(r.id) || outcome.get(r.id) === "none").map((r) => r.id);
  if (!open.length) return console.log(`sweep: ${recent.length} notes, all settled`);

  const rows = await get<Tp[]>(
    `nb_touchpoints?select=id,account_id,raw_text,parsed,created_at&id=in.(${open.join(",")})`,
  );
  const candidates: Tp[] = [];
  for (const tp of rows) {
    if (!tp.parsed || ["field_note", "email_out", "newsletter"].includes(tp.parsed.activity?.kind ?? "")) continue;
    if (!outcome.has(tp.id)) {
      candidates.push(tp);
      continue;
    }
    if (!givenEmails(tp.raw_text, tp.parsed.people).length) continue;
    const drafted = await get<{ id: string }[]>(
      `nb_outbound_drafts?select=id&account_id=eq.${tp.account_id}&created_at=gte.${encodeURIComponent(tp.created_at)}&limit=1`,
    );
    if (!drafted.length) candidates.push(tp);
  }
  if (!candidates.length) return console.log(`sweep: ${recent.length} notes, nothing owed`);

  const state: Record<string, { tries: number; at: string }> = existsSync(STATE)
    ? JSON.parse(readFileSync(STATE, "utf8"))
    : {};
  for (const [id, s] of Object.entries(state)) if (s.at < since) delete state[id]; // the bound
  for (const tp of candidates) {
    const tries = state[tp.id]?.tries ?? 0;
    if (tries >= MAX_TRIES) continue;
    state[tp.id] = { tries: tries + 1, at: new Date().toISOString() };
    // A stored outcome was decided under an older rule or never finished;
    // clear it so the current rule decides. Two stores hold it:
    // withIdempotency's key and once()'s "once:"-prefixed claim.
    {
      const key = `outbound:visit:${tp.id}`;
      for (const k of [key, `once:${key}`]) {
        await fetch(`${SB_URL}/rest/v1/nb_idempotency_keys?id=eq.${encodeURIComponent(k)}`, { method: "DELETE", headers: H });
      }
    }
    console.log("sweep:", tp.id, JSON.stringify(await draft(tp)));
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--sweep") return sweep();
  if (!args.length) throw new Error("Pass touchpoint ids, or --sweep.");
  return byIds(args);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
