/**
 * Filing one note from the inbox (waiting.ts): the Mac's read arrives at
 * /api/mac/waiting, or his pick of a store arrives at /api/visit/inbox. Both
 * file through the one recordTouchpoint and then finish what the phone used
 * to do after filing: the door reads on the account, the photo on the
 * touchpoint, and the refused visit an edit replaces.
 *
 * Filed under `visit:touchpoint:<key>` (the phone's own idempotency key), so
 * any retry of the same note, from the phone or the Mac, replays this answer.
 */
import "server-only";
import { withIdempotency } from "../../core/idempotency";
import { recordTouchpoint, type ParsedTouchpoint, type RecordTouchpointResult } from "./touchpoint";
import { createAccountForNote } from "./new-account";
import {
  appendTouchpointAttachments,
  DOOR_COUNT_FIELDS,
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
import { getWaiting, settleWaiting, type WaitingNote } from "./waiting";

type Filed = Extract<RecordTouchpointResult, { ok: true; needsAccount: false }>;
type Needs = Extract<RecordTouchpointResult, { needsAccount: true }>;

export type FileOutcome =
  | { status: "filed"; touchpointId: string | null; accountId: string | null; accountName: string | null }
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

/** Five reads a note gets before it stays red: 2, 4, 8, 16 minutes apart. */
const MAX_ATTEMPTS = 5;
const backoff = (attempts: number) => new Date(Date.now() + 2 ** Math.max(1, attempts) * 60_000).toISOString();

async function finish(note: WaitingNote, r: Filed): Promise<void> {
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

/** The Mac's read of a claimed note. A New company note whose store the read
 *  names but the book does not have creates it, as the phone used to. */
export async function fileFromMacRead(key: string, macParsed: unknown): Promise<FileOutcome> {
  const note = await getWaiting(key);
  if (!note) return { status: "withdrawn" };
  if (note.status === "filed") {
    return { status: "filed", touchpointId: note.touchpoint_id, accountId: note.account_id, accountName: note.account_name };
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
