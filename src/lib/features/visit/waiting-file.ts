/**
 * Filing one note from the inbox (waiting.ts). Three ways in, one record out:
 *
 * - RAW, on the server (fileRaw, from /api/notes/drain on pg_cron): the store
 *   is known at send and the Mac has not read the note within 20 minutes, so
 *   the note files in his own words, with no model and no laptop. One
 *   activity, one touchpoint, the HubSpot record in his words.
 * - THE MAC'S READ (fileFromMacRead, /api/mac/waiting): a note never filed
 *   files from the read, as before; a note filed raw is enriched in place
 *   (enrichRawTouchpoint), the same activity and the same HubSpot record.
 * - HIS PICK of a store for a note the read could not place (fileToPicked).
 *
 * Then what the phone used to do after filing: the door reads on the account,
 * the photo on the touchpoint, and the refused visit an edit replaces.
 *
 * Every filing runs under its own idempotency key, so a retry of any of them,
 * from the phone, the Mac or pg_cron, replays its first answer.
 */
import "server-only";
import { withIdempotency } from "../../core/idempotency";
import {
  autoFileEngagement,
  enrichRawTouchpoint,
  isParsedTouchpoint,
  recordTouchpoint,
  type ParsedTouchpoint,
  type RecordTouchpointResult,
} from "./touchpoint";
import { TouchpointSchema } from "./touchpoint-schema";
import { rawKind } from "./note-path-core";
import { createAccountForNote } from "./new-account";
import { readBackLatestEngagement } from "./hubspot-engagement";
import {
  appendTouchpointAttachments,
  DOOR_COUNT_FIELDS,
  findFiledTouchpoint,
  insertRawActivity,
  insertTouchpoint,
  READINESS_VALUES,
  setAccountCounts,
  setAccountPotentialJuan,
  setAccountReadiness,
  VISIT_GRADES,
  withdrawUnfiledVisit,
  type DoorCountField,
  type Readiness,
  type VisitGrade,
} from "./dal";
import { CANARY_ACCOUNT, getWaiting, settleWaiting, type WaitingNote } from "./waiting";

type Filed = Extract<RecordTouchpointResult, { ok: true; needsAccount: false }>;
type Needs = Extract<RecordTouchpointResult, { needsAccount: true }>;

export type FileOutcome =
  | { status: "filed"; touchpointId: string | null; accountId: string | null; accountName: string | null }
  | { status: "raw_filed"; touchpointId: string; activityId: number; hubspot: boolean }
  | { status: "needs_account" }
  | { status: "withdrawn" }
  | { status: "retry"; error: string }
  | { status: "failed"; error: string };

class NotFiled extends Error {}
class NotSure extends Error {
  constructor(readonly result: Needs) {
    super("Not sure which store.");
  }
}

/** Five tries a note gets before it stays red: 2, 4, 8, 16 minutes apart. */
const MAX_ATTEMPTS = 5;
/** The server's raw filing gets its own five after whatever the Mac spent (0117). */
const RAW_MAX_ATTEMPTS = 10;
const backoff = (attempts: number) => new Date(Date.now() + 2 ** Math.max(1, attempts) * 60_000).toISOString();

async function finish(note: WaitingNote, r: { accountId: string | null; touchpoint_id: string | null }): Promise<void> {
  const accountId = r.accountId ?? null;
  const read = note.door_read;
  if (accountId && read) {
    if (read.grade && (VISIT_GRADES as readonly string[]).includes(read.grade)) await setAccountPotentialJuan(accountId, read.grade as VisitGrade);
    if (read.readiness && (READINESS_VALUES as readonly string[]).includes(read.readiness)) {
      await setAccountReadiness(accountId, read.readiness as Readiness);
    }
    const counts: Partial<Record<DoorCountField, number>> = {};
    for (const f of DOOR_COUNT_FIELDS) {
      const v = read.counts?.[f];
      if (Number.isInteger(v) && (v as number) >= 0) counts[f] = v as number;
    }
    if (Object.keys(counts).length) await setAccountCounts(accountId, counts);
  }
  // A photo sent after filing went straight to the touchpoint; these came first.
  const fresh = await getWaiting(note.key).catch(() => null);
  const atts = fresh?.attachments ?? note.attachments;
  if (r.touchpoint_id && atts.length) await appendTouchpointAttachments(r.touchpoint_id, atts);
  const old = note.replaces;
  if (old?.touchpointId && Number.isInteger(old.activityId) && r.touchpoint_id && r.touchpoint_id !== old.touchpointId) {
    await withdrawUnfiledVisit(old.touchpointId, old.activityId!).catch(() => false);
  }
}

async function settle(note: WaitingNote, run: () => Promise<RecordTouchpointResult>, idemKey: string): Promise<FileOutcome> {
  try {
    const { result } = await withIdempotency(idemKey, async () => {
      const r = await run();
      if (!r.ok) throw new NotFiled(r.error);
      if (r.needsAccount) throw new NotSure(r);
      return r;
    });
    const r = result as Filed;
    await finish(note, r);
    await settleWaiting(note.key, "filed", {
      touchpoint_id: r.touchpoint_id ?? null,
      account_id: r.accountId ?? note.account_id,
      account_name: r.accountName ?? note.account_name,
      error: null,
    });
    return { status: "filed", touchpointId: r.touchpoint_id ?? null, accountId: r.accountId ?? null, accountName: r.accountName ?? null };
  } catch (err) {
    if (err instanceof NotSure) {
      const n = err.result;
      await settleWaiting(note.key, "needs_account", {
        needs: {
          candidates: n.candidates,
          businessNameGuess: n.businessNameGuess,
          matchAccountId: n.matchAccountId,
          matchAccountName: n.matchAccountName,
          parsed: n.parsed,
        },
        error: n.businessNameGuess ? `Couldn't tell which store "${n.businessNameGuess}" is.` : "Couldn't tell which store this was.",
      });
      return { status: "needs_account" };
    }
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    if (note.attempts >= MAX_ATTEMPTS) {
      await settleWaiting(note.key, "failed", { error: msg });
      return { status: "failed", error: msg };
    }
    await settleWaiting(note.key, "waiting", { error: msg, next_at: backoff(note.attempts) });
    return { status: "retry", error: msg };
  }
}

// ---------------------------------------------------------------------------
// raw, on the server
// ---------------------------------------------------------------------------

/** One note claimed by nb_raw_claim: filed in his words, then HubSpot once
 *  inline (the drain retries it on its own schedule after that). The canary's
 *  note lands on its synthetic account and reads back the latest real record
 *  instead of writing one: the shared portal never gets a test record. */
export async function fileRaw(note: WaitingNote): Promise<FileOutcome> {
  const accountId = note.account_id;
  if (!accountId || note.kind_override === "field_note") {
    await settleWaiting(note.key, "waiting", { error: null });
    return { status: "retry", error: "Not a note the server files without a read." };
  }
  const canary = note.rep === "canary";
  if (canary && accountId !== CANARY_ACCOUNT) {
    await settleWaiting(note.key, "failed", { error: "A canary note must stay on its own account." });
    return { status: "failed", error: "A canary note must stay on its own account." };
  }
  const kind = rawKind(note.kind_override)!;
  try {
    const { result: raw } = await withIdempotency(`visit:raw:${note.key}`, async () => {
      // A half-finished earlier try left its touchpoint: that is the note.
      const earlier = canary ? null : await findFiledTouchpoint(accountId, note.text).catch(() => null);
      if (earlier?.activity_id) return { activityId: earlier.activity_id, touchpointId: earlier.id };
      const activity = await insertRawActivity(
        { account_id: accountId, kind, direction: "outbound", outcome: null, detail: note.text, ...(note.occurred_at ? { at: note.occurred_at } : {}) },
        { canary },
      );
      const tpRow = { account_id: accountId, raw_text: note.text, status: "pending", account_match_confidence: "high", activity_id: activity.id, parsed: null };
      const tp = await insertTouchpoint(tpRow).catch(() => insertTouchpoint(tpRow));
      return { activityId: activity.id, touchpointId: tp.id };
    });
    await finish(note, { accountId, touchpoint_id: raw.touchpointId });

    let hubspot = false;
    let report: Record<string, unknown> | null = null;
    if (canary) {
      const latest = await latestRealFiledActivity();
      const back = latest ? await readBackLatestEngagement(latest).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })) : { error: "No filed record to read back." };
      hubspot = "id" in back && back.hasMarker;
      report = { hubspot: back, activityId: raw.activityId };
    } else {
      hubspot = (await autoFileEngagement(raw.activityId)).hubspotFiled;
    }
    await settleWaiting(note.key, "raw_filed", {
      touchpoint_id: raw.touchpointId,
      activity_id: raw.activityId,
      raw_filed_at: new Date().toISOString(),
      error: null,
      ...(report ? { report } : {}),
    });
    return { status: "raw_filed", touchpointId: raw.touchpointId, activityId: raw.activityId, hubspot };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    if (note.attempts >= RAW_MAX_ATTEMPTS) {
      await settleWaiting(note.key, "failed", { error: msg });
      return { status: "failed", error: msg };
    }
    await settleWaiting(note.key, "waiting", { error: msg, next_at: backoff(Math.min(note.attempts, 5)) });
    return { status: "retry", error: msg };
  }
}

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

async function latestRealFiledActivity(): Promise<number | null> {
  const res = await fetch(
    `${SB_URL}/rest/v1/nb_activities?hubspot_engagement_id=not.is.null&origin=eq.manual&kind=in.(visit,meeting,call)&select=id&order=id.desc&limit=1`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }, cache: "no-store" },
  );
  if (!res.ok) return null;
  const [row] = (await res.json()) as { id: number }[];
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// the Mac's read
// ---------------------------------------------------------------------------

/** The Mac's read of a claimed note. A note the server filed raw is enriched
 *  in place. A New company note whose store the read names but the book does
 *  not have creates it, as the phone used to. */
export async function fileFromMacRead(key: string, macParsed: unknown): Promise<FileOutcome> {
  const note = await getWaiting(key);
  if (!note) return { status: "withdrawn" };
  if (note.status === "filed") {
    return { status: "filed", touchpointId: note.touchpoint_id, accountId: note.account_id, accountName: note.account_name };
  }
  if ((note.status === "raw_filed" || note.status === "enriching") && note.activity_id && note.touchpoint_id && note.account_id) {
    return enrich(note, macParsed);
  }
  const opts = { kindOverride: note.kind_override ?? undefined, occurredAt: note.occurred_at, tryMac: false };
  return settle(
    note,
    async () => {
      const r = await recordTouchpoint(note.text, note.account_id_hint, { ...opts, forceNewAccount: note.force_new_account, macParsed });
      if (r.ok && r.needsAccount && note.force_new_account && r.businessNameGuess?.trim()) {
        const created = await createAccountForNote({ name: r.businessNameGuess.trim(), near: note.near });
        return recordTouchpoint(note.text, created.accountId, { ...opts, parsed: r.parsed });
      }
      return r;
    },
    `visit:touchpoint:${key}`,
  );
}

async function enrich(note: WaitingNote, macParsed: unknown): Promise<FileOutcome> {
  const read = TouchpointSchema.safeParse(macParsed);
  if (!read.success || !isParsedTouchpoint(read.data)) {
    await settleWaiting(note.key, "raw_filed", { error: "That read does not fit the schema; the note stays as he wrote it.", next_at: backoff(note.read_attempts) });
    return { status: "retry", error: "That read does not fit the schema." };
  }
  const parsed = read.data as ParsedTouchpoint;
  if (note.kind_override) parsed.activity.kind = (note.kind_override === "email" ? "email_out" : note.kind_override) as ParsedTouchpoint["activity"]["kind"];
  try {
    const { result } = await withIdempotency(`visit:enrich:${note.key}`, () =>
      enrichRawTouchpoint(
        { activityId: note.activity_id!, touchpointId: note.touchpoint_id!, accountId: note.account_id!, accountName: note.account_name, kind: rawKind(note.kind_override) ?? "visit" },
        note.text,
        parsed,
      ),
    );
    await settleWaiting(note.key, "filed", { error: result.hubspotError ?? null });
    return { status: "filed", touchpointId: note.touchpoint_id, accountId: note.account_id, accountName: note.account_name };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    // Already filed in his words: a read that fails leaves it there, and the
    // Mac tries again later. Five reads and it stays as he wrote it.
    await settleWaiting(note.key, note.read_attempts >= MAX_ATTEMPTS ? "filed" : "raw_filed", { error: msg, next_at: backoff(note.read_attempts) });
    return { status: "retry", error: msg };
  }
}

/** His pick of a store for a note the read could not place: the read already
 *  made is reused, so no second model call. */
export async function fileToPicked(key: string, accountId: string): Promise<FileOutcome> {
  const note = await getWaiting(key);
  if (!note) return { status: "withdrawn" };
  if (note.status === "filed") {
    return { status: "filed", touchpointId: note.touchpoint_id, accountId: note.account_id, accountName: note.account_name };
  }
  const parsed = note.needs?.parsed as ParsedTouchpoint | undefined;
  if (!parsed) return { status: "failed", error: "This note has not been read yet." };
  return settle(
    note,
    () => recordTouchpoint(note.text, accountId, { parsed, kindOverride: note.kind_override ?? undefined, occurredAt: note.occurred_at, tryMac: false }),
    `visit:touchpoint:${key}:${accountId}`,
  );
}
