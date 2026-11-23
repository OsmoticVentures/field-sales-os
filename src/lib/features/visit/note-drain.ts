/**
 * The server's own schedule for notes (migration 0115): pg_cron runs
 * nb_notes_tick every two minutes inside Postgres and calls /api/notes/drain
 * only when something is due, so the laptop is never on the critical path.
 *
 * 1. Raw filing: every note whose store is known and that the Mac has not
 *    read within 20 minutes files in his words (waiting-file.ts fileRaw).
 * 2. HubSpot retry: every filed activity on his book with no HubSpot record
 *    is filed through the one engagement filer, backing off 10, 20, 40
 *    minutes up to 6 hours (nb_hubspot_retry, the same rows the Mac's sweep
 *    keeps). The filer finds its own earlier record first, so a retry never
 *    makes a second one.
 *
 * Each run leaves one heartbeat row (nb_note_heartbeats, keyed by step) for
 * the watchdog. Free: pg_cron and pg_net on the Supabase project, a Vercel
 * function call, no model.
 */
import "server-only";
import { fileRaw, type FileOutcome } from "./waiting-file";
import type { WaitingNote } from "./waiting";
import { NeverFiledKindError, runEngagement } from "./hubspot-engagement";
import { writeEnabled } from "./hubspot";
import { myOwnerId } from "../../core/user";
import { RAW_GRACE_MIN, retryRow } from "./note-path-core";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const H = () => ({ apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" });

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers: H(), body: JSON.stringify(args), cache: "no-store" });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

async function hubspotRetries(): Promise<{ tried: number; filed: number }> {
  if (!writeEnabled("visit")) return { tried: 0, filed: 0 };
  const sweep = await rpc<{ due?: number[] }>("nb_note_sweep", { p_owner: await myOwnerId() });
  const due = (sweep.due ?? []).map(Number).filter(Number.isInteger);
  if (!due.length) return { tried: 0, filed: 0 };
  const res = await fetch(`${SB_URL}/rest/v1/nb_hubspot_retry?activity_id=in.(${due.join(",")})&select=activity_id,attempts`, { headers: H(), cache: "no-store" });
  const have = new Map(((res.ok ? await res.json() : []) as { activity_id: number; attempts: number }[]).map((r) => [r.activity_id, r.attempts]));
  let filed = 0;
  for (const id of due) {
    const attempts = have.get(id) ?? 0;
    let row: Record<string, unknown>;
    try {
      const out = await runEngagement(id, { write: true, feature: "visit" });
      const ok = Boolean(out.wrote || out.alreadyFiledId || out.noteId);
      if (ok) filed += 1;
      row = retryRow(id, attempts, ok ? { ok: true } : { ok: false, error: "HubSpot did not confirm the note." });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      row = retryRow(id, attempts, { ok: false, error: msg, neverFiled: e instanceof NeverFiledKindError });
    }
    await fetch(`${SB_URL}/rest/v1/nb_hubspot_retry?on_conflict=activity_id`, {
      method: "POST",
      headers: { ...H(), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
      cache: "no-store",
    });
  }
  return { tried: due.length, filed };
}

export type DrainReport = { raw: { key: string; status: FileOutcome["status"] }[]; hubspot: { tried: number; filed: number }; error?: string };

export async function drainNotes(): Promise<DrainReport> {
  const report: DrainReport = { raw: [], hubspot: { tried: 0, filed: 0 } };
  const errors: string[] = [];
  try {
    const claimed = await rpc<WaitingNote[]>("nb_raw_claim", { p_grace_min: RAW_GRACE_MIN });
    for (const note of claimed) {
      const out = await fileRaw(note);
      report.raw.push({ key: note.key, status: out.status });
      if (out.status === "retry" || out.status === "failed") errors.push(out.error);
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  try {
    report.hubspot = await hubspotRetries();
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  if (errors.length) report.error = errors.join(" | ").slice(0, 500);
  await fetch(`${SB_URL}/rest/v1/nb_note_heartbeats?on_conflict=step`, {
    method: "POST",
    headers: { ...H(), Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ step: "drain", at: new Date().toISOString(), ok: !report.error, detail: JSON.stringify(report).slice(0, 500) }),
    cache: "no-store",
  }).catch(() => null);
  return report;
}
