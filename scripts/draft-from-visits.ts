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
 * MAX_TRIES sweep attempts, counted in STATE (pruned past SWEEP_DAYS). A run
 * stopped because the AI itself is out (no credit, the daily cap) ends the pass
 * and costs nothing: the owed email waits for the AI, it was never refused.
 *
 * The same run drafts every promised follow-up email whose day has come:
 * `[follow-up:email]` directives (target FOLLOW_UP_TARGET) filed from a visit
 * note (from-visit.ts) or a sent email (bridges/nutribiotic/sent_promises.py).
 * A drafted one is marked routed; one that cannot be written gets MAX_TRIES.
 *
 * Needs NB_SUPABASE_* in the env, and NB_AI_CLI=1 to answer on the Max plan
 * (follow_through_cron.sh sets it). Runs as rep
 * NB_SCRIPT_USER (default "juan"), so it drafts for that rep's book only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { draftFromVisit, givenEmails } from "../src/lib/features/outbound/from-visit";
import { loadAskInputs } from "../src/lib/features/outbound/actions";
import { composeAsk } from "../src/lib/features/outbound/compose";
import { FOLLOW_UP_TARGET, insertAskDraft } from "../src/lib/features/outbound/dal";
import { laDay } from "../src/lib/core/once-server";
import { AI_CAP_MESSAGE, AI_CREDITS_MESSAGE, AI_LEDGER_DOWN_MESSAGE } from "../src/lib/core/ai/core";

process.env.NB_SCRIPT_USER ??= "juan";
const SB_URL = process.env.NB_SUPABASE_URL!;
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY!;
const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` };

const SWEEP_DAYS = 3;
const MAX_TRIES = 3;
const STATE = process.env.VISIT_SWEEP_STATE ?? `${process.env.HOME}/agency/bridges/nutribiotic/.visit-draft-sweep.json`;

/** The AI is out, for every note alike. Says nothing about this note. */
const aiOut = (reason?: string) =>
  [AI_CREDITS_MESSAGE, AI_CAP_MESSAGE, AI_LEDGER_DOWN_MESSAGE, "The model could not answer"].some((m) =>
    reason?.toLowerCase().includes(m.toLowerCase()),
  );

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
    const before = state[tp.id];
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
    const out = await draft(tp);
    console.log("sweep:", tp.id, JSON.stringify(out));
    if (aiOut((out as { reason?: string }).reason)) {
      if (before) state[tp.id] = before;
      else delete state[tp.id];
      break;
    }
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1));
}

type Directive = { id: string; account_id: string | null; directive: string; created_at: string };

/** Promised follow-up emails whose day is today or past, drafted into Outbound. */
async function dueFollowUps(state: Record<string, { tries: number; at: string }>) {
  const rows = await get<Directive[]>(
    `nb_directives?select=id,account_id,directive,created_at&target=eq.${FOLLOW_UP_TARGET}&status=eq.pending&limit=200`,
  );
  const today = laDay();
  for (const d of rows) {
    const on = d.directive.match(/Stated time: (\d{4}-\d{2}-\d{2})/)?.[1] ?? laDay(new Date(Date.parse(d.created_at) + 7 * 864e5));
    if (!d.account_id || on > today) continue;
    const tries = state[d.id]?.tries ?? 0;
    if (tries >= MAX_TRIES) continue;
    const before = state[d.id];
    state[d.id] = { tries: tries + 1, at: new Date().toISOString() };

    const what = d.directive.replace(/^\[follow-up:email\]\s*/, "").split(" · ")[0];
    const { account, contacts, voice } = await loadAskInputs(d.account_id);
    if (!account) {
      console.log("follow-up:", d.id, "skipped: not in this rep's book");
      continue;
    }
    // The promise, plus the last notes and sent emails on the account, are the sources.
    const recent = await get<{ raw_text: string; created_at: string }[]>(
      `nb_touchpoints?select=raw_text,created_at&account_id=eq.${d.account_id}&order=created_at.desc&limit=3`,
    );
    const promisedOn = d.created_at.slice(0, 10);
    const composed = await composeAsk({
      ask:
        `The follow-up he promised on ${promisedOn}, written to go out now: ${what}. ` +
        "This is a second email, not a first one: do not re-introduce him or the company, do not repeat what the earlier email or visit already said or attached, and do not promise to reach out again. Pick up where the promise left off and make the one ask.",
      noteText: [
        `THE PROMISE, made ${promisedOn}: ${d.directive}`,
        ...recent.map((r) => `EARLIER CONTACT ${r.created_at.slice(0, 10)}: ${r.raw_text}`),
      ].join("\n\n"),
      account: { id: account.id, name: account.name, city: account.city, email: account.email },
      contacts,
      voice,
    });
    if (!composed.written) {
      console.log("follow-up:", d.id, "not written:", composed.reason);
      if (aiOut(composed.reason)) {
        if (before) state[d.id] = before;
        else delete state[d.id];
        break;
      }
      continue;
    }
    const row = await insertAskDraft({
      account_id: d.account_id,
      ask: what,
      composed,
      urgency: { level: 2, reason: `Follow-up you promised for ${on}` },
      source_directive_id: d.id,
    });
    if (!row) continue;
    await fetch(`${SB_URL}/rest/v1/nb_directives?id=eq.${encodeURIComponent(d.id)}`, {
      method: "PATCH",
      headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "routed" }),
    });
    console.log("follow-up:", d.id, "drafted", row.id, row.to_email ?? "(no address)");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--sweep") {
    await sweep();
    const state: Record<string, { tries: number; at: string }> = existsSync(STATE)
      ? JSON.parse(readFileSync(STATE, "utf8"))
      : {};
    const cutoff = new Date(Date.now() - 30 * 864e5).toISOString();
    for (const [id, s] of Object.entries(state)) if (s.at < cutoff) delete state[id]; // the bound
    await dueFollowUps(state);
    writeFileSync(STATE, JSON.stringify(state, null, 1));
    return;
  }
  if (!args.length) throw new Error("Pass touchpoint ids, or --sweep.");
  return byIds(args);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
