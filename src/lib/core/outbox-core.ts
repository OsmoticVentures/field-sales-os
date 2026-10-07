/**
 * THE OUTBOX STATE MACHINE. Pure: no IndexedDB, no fetch, no window. The
 * browser half (outbox.ts) hands it a store and a transport; the tests hand
 * it fakes. Kept import-free so `node --experimental-strip-types` can load it.
 *
 * One item is one visit note, from the tap on Log until HubSpot has said yes.
 * Its stages run in order and each one is recorded on the item the moment it
 * lands, so a restart resumes at the next unfinished stage:
 *
 *   touchpoint   POST /api/visit/touchpoint, key = item id (the server's
 *                idempotency guard replays a landed write, never redoes it).
 *                Not sure which store: with New company on, create it
 *                (/api/visit/new-account) and file to it; otherwise park the
 *                item until a store is tapped.
 *   hubspot      POST /api/visit/refile until HubSpot confirms. The server
 *                checks for its own earlier note first, so a retry never
 *                makes a second one. "CRM filing off" and a field note count
 *                as done: there is nothing to confirm.
 *   read         grade and readiness, POST /api/visit/account-read.
 *   photo        POST /api/visit/attach.
 *   type         a store New company just created: its type is his pick,
 *                asked once the note is filed, POST /api/visit/account-type.
 *
 * After the note is filed, hubspot, read and photo are independent: one
 * failing does not hold the others in the same pass.
 *
 * An item leaves the store only when filed, HubSpot is done/off/n-a, the read
 * is applied and the photo attached, or when he discards it by hand. Nothing
 * else deletes it, and no error ever does.
 */

export type KindOverride = "meeting" | "call" | "email" | "field_note";

export type AccountPick = { id: string; name: string; city: string | null };

/** A store New company created: the type Places suggested, the one he
 *  picked, and whether it is on the account. */
export type OutboundNotice =
  | { status: "drafted"; draftId: string; toEmail: string | null }
  | { status: "not_written"; reason: string }
  | { status: "none" }
  | { status: "already_queued" };

export type StoreType = { suggested: string | null; picked: string | null; done: boolean };

export type NeedsAccount = {
  candidates: AccountPick[];
  businessNameGuess: string | null;
  matchAccountId: string | null;
  matchAccountName: string | null;
  parsed: unknown;
};

export type OutboxItem = {
  id: string;
  text: string;
  accountIdHint: string | null;
  kind: KindOverride | null;
  newCompany: boolean;
  grade: string | null;
  readiness: string | null;
  /** Bytes, not a Blob: an ArrayBuffer survives every WebKit IndexedDB. */
  photo: { bytes: ArrayBuffer; type: string; name: string } | null;
  /** Where the phone was when Log was tapped, for finding a new store. */
  near?: { lat: number; lng: number } | null;
  createdAt: number;

  // step state, written after every stage
  accountName: string | null;
  /** A store tapped from the picks, or the one New company just created. */
  pickedAccountId: string | null;
  /** The server's parse, sent back with the pick so the note is not re-read. */
  parsed: unknown;
  newCompanyName: string | null;
  accountId: string | null;
  touchpointId: string | null;
  activityId: number | null;
  summary: string | null;
  filed: boolean;
  hubspot: "pending" | "done" | "off" | "n/a";
  /** HubSpot's own refusal reason, when it is not a passing miss. */
  hubspotRefused: string | null;
  readDone: boolean;
  photoDone: boolean;
  /** Null unless New company created the store. */
  storeType?: StoreType | null;
  /** The email the server decided this visit leaves owing, once filed. */
  outbound?: OutboundNotice | null;

  attempts: number;
  nextAt: number;
  /** A write that may still be running on the server is not sent again
   *  before this, so a retry can never race its own first try. */
  holdUntil: number;
  lastError: string | null;
  offline: boolean;
  parked: null | "needs-account" | "rejected";
  needsAccount: NeedsAccount | null;
};

export type EnqueueInput = {
  id: string;
  text: string;
  accountIdHint?: string | null;
  accountName?: string | null;
  kind?: KindOverride | null;
  newCompany?: boolean;
  grade?: string | null;
  readiness?: string | null;
  photo?: OutboxItem["photo"];
  near?: { lat: number; lng: number } | null;
  now: number;
};

export function newItem(i: EnqueueInput): OutboxItem {
  return {
    id: i.id,
    text: i.text,
    accountIdHint: i.accountIdHint ?? null,
    kind: i.kind ?? null,
    newCompany: Boolean(i.newCompany) && !i.accountIdHint,
    grade: i.grade ?? null,
    readiness: i.readiness ?? null,
    photo: i.photo ?? null,
    near: i.near ?? null,
    createdAt: i.now,
    accountName: i.accountName ?? null,
    pickedAccountId: null,
    parsed: null,
    newCompanyName: null,
    accountId: null,
    touchpointId: null,
    activityId: null,
    summary: null,
    filed: false,
    hubspot: "pending",
    hubspotRefused: null,
    readDone: !i.grade && !i.readiness,
    photoDone: !i.photo,
    storeType: null,
    attempts: 0,
    nextAt: i.now,
    holdUntil: 0,
    lastError: null,
    offline: false,
    parked: null,
    needsAccount: null,
  };
}

// ---------------------------------------------------------------------------
// stages
// ---------------------------------------------------------------------------

export type Stage = "touchpoint" | "new-account" | "hubspot" | "read" | "photo" | "type";

export type Req = {
  path: string;
  key?: string;
  json?: unknown;
  /** Multipart for the photo; the transport builds the FormData. */
  form?: { touchpoint_id: string; idempotency_key: string; photo: NonNullable<OutboxItem["photo"]> };
};

export type Step = { stage: Stage; req: Req };

/** What the transport saw. `network` covers no signal, a dropped request and
 *  a timeout; `http` is any answer that was not `{ ok: true }`. */
export type Outcome =
  | { type: "ok"; result: unknown }
  | { type: "network" }
  | { type: "http"; status: number; error: string | null };

export const isComplete = (it: OutboxItem): boolean =>
  it.filed && it.hubspot !== "pending" && it.readDone && it.photoDone && (!it.storeType || it.storeType.done);

/** Filed, and nothing left but his pick of the new store's type. */
export const waitsForType = (it: OutboxItem): boolean =>
  it.filed && it.hubspot !== "pending" && it.readDone && it.photoDone && Boolean(it.storeType && !it.storeType.done && !it.storeType.picked);

/** The next stage to run, skipping the ones that already failed this pass.
 *  Null when the item is complete, parked, or waiting on a filed note. */
export function nextStep(it: OutboxItem, skip: ReadonlySet<Stage> = new Set()): Step | null {
  if (it.parked) return null;
  const kindOverride = it.kind ?? undefined;

  if (!it.filed) {
    if (skip.has("touchpoint") || skip.has("new-account")) return null;
    if (it.newCompany && it.newCompanyName && !it.pickedAccountId) {
      const name = it.newCompanyName;
      return {
        stage: "new-account",
        req: { path: "/api/visit/new-account", key: `${it.id}:new:${name.toLowerCase()}`, json: { name, near: it.near ?? undefined } },
      };
    }
    if (it.pickedAccountId) {
      return {
        stage: "touchpoint",
        req: {
          path: "/api/visit/touchpoint",
          key: `${it.id}:${it.pickedAccountId}`,
          json: { text: it.text, accountIdHint: it.pickedAccountId, kindOverride, parsed: it.parsed ?? undefined },
        },
      };
    }
    return {
      stage: "touchpoint",
      req: {
        path: "/api/visit/touchpoint",
        key: it.id,
        json: { text: it.text, accountIdHint: it.accountIdHint ?? undefined, kindOverride, forceNewAccount: it.newCompany },
      },
    };
  }

  if (it.hubspot === "pending" && !skip.has("hubspot") && it.activityId) {
    return { stage: "hubspot", req: { path: "/api/visit/refile", json: { activityId: it.activityId } } };
  }
  if (!it.readDone && !skip.has("read") && it.accountId) {
    return {
      stage: "read",
      req: {
        path: "/api/visit/account-read",
        key: `${it.id}:read`,
        json: { account_id: it.accountId, grade: it.grade ?? undefined, readiness: it.readiness ?? undefined },
      },
    };
  }
  if (!it.photoDone && !skip.has("photo") && it.photo && it.touchpointId) {
    return {
      stage: "photo",
      req: {
        path: "/api/visit/attach",
        key: `${it.id}:photo`,
        form: { touchpoint_id: it.touchpointId, idempotency_key: `${it.id}:photo`, photo: it.photo },
      },
    };
  }
  const st = it.storeType;
  if (st && !st.done && st.picked && !skip.has("type") && it.accountId) {
    return { stage: "type", req: { path: "/api/visit/account-type", key: `${it.id}:type:${st.picked}`, json: { account_id: it.accountId, channel: st.picked } } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

/** 5s, 15s, 30s, 1m, 2m, 5m, then every 10m, each within 10% either way. */
const LADDER = [5, 15, 30, 60, 120, 300];
export function backoffMs(attempts: number, rand: number): number {
  const s = attempts <= 0 ? LADDER[0] : (LADDER[attempts - 1] ?? 600);
  return Math.round(s * 1000 * (0.9 + 0.2 * rand));
}

/** Longer than the routes' maxDuration (60s): past this, a first try that
 *  may have reached the server has finished, landed or not. */
export const SERVER_WINDOW_MS = 65_000;

/** An answer that cannot turn into a yes by asking again. Everything else,
 *  including 401 (re-gated later), 422 (the note reader can miss once) and
 *  every 5xx, is retried. */
const PERMANENT = new Set([400, 405, 413, 415]);

type FiledShape = {
  needsAccount: false;
  touchpoint_id: string;
  accountName: string | null;
  accountId: string | null;
  activityId: number | null;
  isFieldNote?: boolean;
  summary: string;
  hubspotFiled: boolean;
  hubspotError: string | null;
  outbound?: OutboundNotice;
};
type NeedsShape = NeedsAccount & { needsAccount: true };
type HubspotShape = { hubspotFiled: boolean; hubspotError: string | null };

export const CRM_OFF = "CRM filing off";
/** The server's wording for a passing miss, as opposed to a stated refusal. */
const PASSING_MISS = "Not filed to HubSpot yet.";

function hubspotState(r: HubspotShape, fieldNote: boolean): Pick<OutboxItem, "hubspot" | "hubspotRefused"> {
  if (fieldNote) return { hubspot: "n/a", hubspotRefused: null };
  if (r.hubspotFiled) return { hubspot: "done", hubspotRefused: null };
  if (r.hubspotError === CRM_OFF) return { hubspot: "off", hubspotRefused: null };
  return { hubspot: "pending", hubspotRefused: r.hubspotError && r.hubspotError !== PASSING_MISS ? r.hubspotError : null };
}

export type ApplyCtx = { now: number; rand: number; /** the phone believed it had signal when the request left */ sentOnline: boolean; sentAt: number };

/** Fold one stage's outcome into the item. `ok` false means the stage did
 *  not finish this pass (failed, or parked waiting for a tap). */
export function applyOutcome(it: OutboxItem, step: Step, out: Outcome, ctx: ApplyCtx): { item: OutboxItem; ok: boolean } {
  if (out.type !== "ok") return { item: failed(it, step, out, ctx), ok: false };
  const base = { ...it, lastError: null, offline: false };

  switch (step.stage) {
    case "new-account": {
      const r = out.result as { accountId: string; accountName: string; channel?: string | null };
      return {
        item: {
          ...base,
          pickedAccountId: r.accountId,
          accountName: r.accountName,
          storeType: { suggested: r.channel ?? null, picked: null, done: false },
        },
        ok: true,
      };
    }
    case "touchpoint": {
      const r = out.result as FiledShape | NeedsShape;
      if (r.needsAccount) {
        const needs: NeedsAccount = {
          candidates: r.candidates ?? [],
          businessNameGuess: r.businessNameGuess ?? null,
          matchAccountId: r.matchAccountId ?? null,
          matchAccountName: r.matchAccountName ?? null,
          parsed: r.parsed,
        };
        // New company: create it from the name the note gave, then file to it.
        const name = r.businessNameGuess?.trim();
        if (it.newCompany && !it.pickedAccountId && name) {
          return { item: { ...base, parsed: r.parsed, newCompanyName: name }, ok: true };
        }
        const lastError = it.newCompany
          ? "Couldn't tell the new store's name."
          : r.businessNameGuess
            ? `Couldn't tell which store "${r.businessNameGuess}" is.`
            : "Couldn't tell which store this was.";
        return {
          item: { ...base, parsed: r.parsed, pickedAccountId: null, needsAccount: needs, parked: "needs-account", lastError },
          ok: false,
        };
      }
      const fieldNote = Boolean(r.isFieldNote);
      return {
        item: {
          ...base,
          filed: true,
          needsAccount: null,
          touchpointId: r.touchpoint_id,
          accountId: r.accountId,
          accountName: r.accountName ?? it.accountName,
          activityId: r.activityId,
          summary: r.summary ?? null,
          outbound: r.outbound ?? null,
          ...hubspotState(r, fieldNote),
          // A read needs an account to land on; a note about no store has none.
          readDone: it.readDone || !r.accountId,
        },
        ok: true,
      };
    }
    case "hubspot": {
      const next = { ...base, ...hubspotState(out.result as HubspotShape, false) };
      if (next.hubspot === "pending") {
        return { item: failed(it, step, { type: "http", status: 503, error: next.hubspotRefused ?? PASSING_MISS }, ctx, next.hubspotRefused), ok: false };
      }
      return { item: next, ok: true };
    }
    case "read":
      return { item: { ...base, readDone: true }, ok: true };
    case "photo":
      return { item: { ...base, photoDone: true }, ok: true };
    case "type":
      return { item: { ...base, storeType: it.storeType ? { ...it.storeType, done: true } : null }, ok: true };
  }
}

function failed(it: OutboxItem, step: Step, out: Exclude<Outcome, { type: "ok" }>, ctx: ApplyCtx, refused?: string | null): OutboxItem {
  const offline = out.type === "network";
  if (out.type === "http" && PERMANENT.has(out.status)) {
    return { ...it, parked: "rejected", lastError: out.error || "Not accepted.", offline: false };
  }
  const attempts = it.attempts + 1;
  let nextAt = ctx.now + backoffMs(attempts, ctx.rand);
  let holdUntil = it.holdUntil;
  // The note and the new store are the two writes a lost answer could
  // double: hold the retry until the first try has surely finished.
  if (offline && ctx.sentOnline && (step.stage === "touchpoint" || step.stage === "new-account")) {
    holdUntil = Math.max(holdUntil, ctx.sentAt + SERVER_WINDOW_MS);
    nextAt = Math.max(nextAt, holdUntil);
  }
  return {
    ...it,
    attempts,
    nextAt,
    holdUntil,
    offline,
    lastError: offline ? null : out.error,
    hubspotRefused: refused !== undefined ? refused : it.hubspotRefused,
  };
}

// ---------------------------------------------------------------------------
// one pass over one item
// ---------------------------------------------------------------------------

export type Deps = {
  send: (req: Req) => Promise<Outcome>;
  /** Persist the item; called after every stage, success or not. */
  save: (it: OutboxItem) => Promise<void>;
  remove: (id: string) => Promise<void>;
  now: () => number;
  rand: () => number;
  online: () => boolean;
};

export const isDue = (it: OutboxItem, now: number): boolean =>
  !it.parked && !waitsForType(it) && it.nextAt <= now && it.holdUntil <= now;

/**
 * Run every stage the item can run now, saving after each. A failure stops
 * the pre-file stages; after filing, a failed stage is skipped for the rest
 * of the pass so the others still run. Answers the item as it now stands,
 * and `removed` when it was complete and has left the store.
 */
export async function advance(item: OutboxItem, deps: Deps): Promise<{ item: OutboxItem; removed: boolean }> {
  let it = item;
  const skip = new Set<Stage>();
  let failedOnce = false;
  for (let guard = 0; guard < 12; guard++) {
    const step = nextStep(it, skip);
    if (!step) break;
    const sentAt = deps.now();
    const sentOnline = deps.online();
    let out: Outcome;
    try {
      out = await deps.send(step.req);
    } catch {
      out = { type: "network" };
    }
    const r = applyOutcome(it, step, out, { now: deps.now(), rand: deps.rand(), sentOnline, sentAt });
    if (!r.ok && failedOnce && r.item.attempts > it.attempts) {
      // One pass is one attempt: a second failed stage keeps the first's clock.
      r.item.attempts = it.attempts;
      r.item.nextAt = Math.max(it.nextAt, r.item.holdUntil);
    }
    it = r.item;
    await deps.save(it);
    if (!r.ok) {
      failedOnce = true;
      if (!it.filed || it.parked) break;
      skip.add(step.stage);
    }
  }
  if (!failedOnce && !it.parked && it.attempts !== 0) {
    it = { ...it, attempts: 0 };
    await deps.save(it);
  }
  if (isComplete(it)) {
    await deps.remove(it.id);
    return { item: it, removed: true };
  }
  return { item: it, removed: false };
}

/** A store tapped from the picks: file to it with the parse already made. */
export function pickAccount(it: OutboxItem, a: { id: string; name: string }, now: number): OutboxItem {
  return {
    ...it,
    pickedAccountId: a.id,
    accountName: a.name,
    newCompany: false,
    parked: null,
    needsAccount: null,
    lastError: null,
    attempts: 0,
    nextAt: now,
  };
}

/** The new store's type, tapped once its note is filed. Null skips it and
 *  leaves the type Places gave, if any. */
export function pickType(it: OutboxItem, channel: string | null, now: number): OutboxItem {
  const st = it.storeType ?? { suggested: null, picked: null, done: false };
  if (!channel) return { ...it, storeType: { ...st, done: true } };
  return { ...it, storeType: { ...st, picked: channel, done: false }, attempts: 0, nextAt: now };
}

/** "Try now": due at once, but never before a held write has finished. */
export const wake = (it: OutboxItem, now: number): OutboxItem =>
  it.parked === "needs-account" ? it : { ...it, parked: null, nextAt: Math.max(now, it.holdUntil) };
