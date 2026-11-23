/**
 * THE NOTE INBOX (nb_waiting_notes, migrations 0113 and 0114). Every note
 * Juan logs lands here in the phone's one request: no model, no laptop. The
 * phone item clears the moment this row is written. The Mac's reader
 * (bridges/nutribiotic/note_reader.py, launchd) then claims the row, reads it
 * on the Max plan and files it through /api/mac/waiting under the phone's own
 * idempotency key, so a phone retry is replayed the same answer and the note
 * files once. HubSpot is its own step after that (hubspot_sweep.py).
 *
 * The account is set here only when it is known without a model: the store
 * he picked, or the one account whose name the note spells out. That is what
 * lets the raw note show on the account at once; the Mac's read still decides
 * where the note files.
 */
import "server-only";
import { listAccountsForMatching, type AccountCandidate } from "./dal";
import type { TouchpointAttachment } from "./dal";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

export type DoorRead = {
  grade?: string | null;
  readiness?: string | null;
  counts?: Record<string, number> | null;
};

export type WaitingStatus = "waiting" | "filing" | "filed" | "needs_account" | "failed";

export type WaitingNote = {
  key: string;
  rep: string;
  text: string;
  account_id_hint: string | null;
  account_id: string | null;
  account_name: string | null;
  kind_override: "meeting" | "call" | "email" | "field_note" | null;
  force_new_account: boolean;
  occurred_at: string | null;
  door_read: DoorRead | null;
  near: { lat: number; lng: number } | null;
  replaces: { touchpointId?: string; activityId?: number } | null;
  attachments: TouchpointAttachment[];
  needs: {
    candidates: AccountCandidate[];
    businessNameGuess: string | null;
    matchAccountId: string | null;
    matchAccountName: string | null;
    parsed: unknown;
  } | null;
  status: WaitingStatus;
  attempts: number;
  error: string | null;
  touchpoint_id: string | null;
  created_at: string;
  updated_at: string;
};

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  if (!SB_URL || !SB_KEY) throw new Error("The note inbox is not configured on this deployment.");
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
    signal: AbortSignal.timeout(8_000),
  });
}

async function must(res: Response, what: string): Promise<Response> {
  if (!res.ok) throw new Error(`${what}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res;
}

// ---------------------------------------------------------------------------
// the account, without a model
// ---------------------------------------------------------------------------

const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim()} `;

/** The book, held ten minutes per server instance: ~90 KB a read, metered. */
let bookCache: { at: number; rows: AccountCandidate[] } | null = null;
async function bookForMatching(): Promise<AccountCandidate[]> {
  if (bookCache && Date.now() - bookCache.at < 10 * 60_000) return bookCache.rows;
  const rows = await listAccountsForMatching();
  bookCache = { at: Date.now(), rows };
  return rows;
}

/** The one account whose full name the note spells out, word for word. Two
 *  names of the same length, or none, and it is left to the Mac's read. */
export async function accountNamedIn(text: string): Promise<AccountCandidate | null> {
  const hay = norm(text);
  let best: AccountCandidate | null = null;
  let bestLen = 0;
  let tie = false;
  for (const a of await bookForMatching().catch(() => [])) {
    const n = norm(a.name ?? "");
    if (n.length < 7 || !hay.includes(n)) continue;
    if (n.length > bestLen) {
      best = a;
      bestLen = n.length;
      tie = false;
    } else if (n.length === bestLen && best?.id !== a.id) tie = true;
  }
  return tie ? null : best;
}

export async function accountName(id: string): Promise<string | null> {
  const res = await sb(`nb_accounts?id=eq.${encodeURIComponent(id)}&select=name&limit=1`);
  if (!res.ok) return null;
  const [row] = (await res.json()) as { name: string }[];
  return row?.name ?? null;
}

// ---------------------------------------------------------------------------
// the phone's door
// ---------------------------------------------------------------------------

export type AcceptInput = {
  key: string;
  rep: string;
  text: string;
  accountIdHint: string | null;
  kindOverride: WaitingNote["kind_override"];
  forceNewAccount: boolean;
  occurredAt: string | null;
  doorRead: DoorRead | null;
  near: WaitingNote["near"];
  replaces: WaitingNote["replaces"];
};

export type Accepted = { accepted: true; key: string; accountId: string | null; accountName: string | null; status: WaitingStatus };

/** Keep the note. A retry under the same key answers with the row as it now
 *  stands and never resets a note the Mac is filing or has filed. */
export async function acceptNote(n: AcceptInput): Promise<Accepted> {
  const existing = await getWaiting(n.key);
  if (existing) {
    return { accepted: true, key: n.key, accountId: existing.account_id, accountName: existing.account_name, status: existing.status };
  }
  let account: { id: string; name: string | null } | null = null;
  if (n.accountIdHint) account = { id: n.accountIdHint, name: await accountName(n.accountIdHint).catch(() => null) };
  else if (!n.forceNewAccount) account = await accountNamedIn(n.text);

  await must(
    await sb("nb_waiting_notes?on_conflict=key", {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        key: n.key,
        rep: n.rep,
        text: n.text,
        account_id_hint: n.accountIdHint,
        account_id: account?.id ?? null,
        account_name: account?.name ?? null,
        kind_override: n.kindOverride,
        force_new_account: n.forceNewAccount,
        occurred_at: n.occurredAt,
        door_read: n.doorRead,
        near: n.near,
        replaces: n.replaces,
      }),
    }),
    "Could not save that note",
  );
  return { accepted: true, key: n.key, accountId: account?.id ?? null, accountName: account?.name ?? null, status: "waiting" };
}

export async function getWaiting(key: string): Promise<WaitingNote | null> {
  const res = await must(await sb(`nb_waiting_notes?key=eq.${encodeURIComponent(key)}&select=*`), "Could not read the note inbox");
  const [row] = (await res.json()) as WaitingNote[];
  return row ?? null;
}

/** The photo, uploaded at send time, filed with the note when it files. */
export async function addAttachment(key: string, att: TouchpointAttachment): Promise<WaitingNote | null> {
  const row = await getWaiting(key);
  if (!row) return null;
  if (row.attachments.some((a) => a.name === att.name)) return row;
  await must(
    await sb(`nb_waiting_notes?key=eq.${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ attachments: [...row.attachments, att], updated_at: new Date().toISOString() }),
    }),
    "Could not keep that photo",
  );
  return { ...row, attachments: [...row.attachments, att] };
}

export async function settleWaiting(
  key: string,
  status: WaitingStatus,
  extra: Partial<Pick<WaitingNote, "error" | "touchpoint_id" | "needs" | "account_id" | "account_name" | "attempts">> & { next_at?: string } = {},
): Promise<void> {
  await must(
    await sb(`nb_waiting_notes?key=eq.${encodeURIComponent(key)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status, ...extra, updated_at: new Date().toISOString() }),
    }),
    "Could not update the note inbox",
  );
}

/** Discarded or taken back: the Mac must not file it. Only a note not yet
 *  filed (or being filed) is removed, under its own key and every key derived
 *  from it (`<id>:<picked account>`). */
export async function withdrawWaiting(id: string): Promise<void> {
  const safe = id.replace(/[^A-Za-z0-9:_-]/g, "");
  if (!safe) return;
  await sb(`nb_waiting_notes?or=(key.eq.${safe},key.like.${safe}:*)&status=in.(waiting,needs_account,failed)`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  }).catch(() => null);
}

/** Every note of this rep's not filed yet, oldest first, for the Visit
 *  screen. Small: unfiled rows only, the text cut to what a line shows. */
export async function listUnfiled(rep: string): Promise<WaitingNote[]> {
  const res = await sb(
    `nb_waiting_notes?rep=eq.${encodeURIComponent(rep)}&status=neq.filed&select=key,text,account_id,account_name,status,attempts,error,needs,created_at,updated_at&order=created_at.asc&limit=50`,
  );
  if (!res.ok) return [];
  return (await res.json()) as WaitingNote[];
}

/** Notes waiting on these accounts, for the account's history before the
 *  Mac has read them. */
export async function unfiledFor(accountIds: string[]): Promise<Pick<WaitingNote, "key" | "account_id" | "text" | "kind_override" | "occurred_at" | "created_at">[]> {
  if (accountIds.length === 0) return [];
  const ids = accountIds.length > 200 ? null : accountIds.map((i) => `"${i}"`).join(",");
  const res = await sb(
    `nb_waiting_notes?status=neq.filed&account_id=${ids ? `in.(${ids})` : "not.is.null"}&select=key,account_id,text,kind_override,occurred_at,created_at&order=created_at.desc&limit=200`,
  ).catch(() => null);
  if (!res?.ok) return [];
  return await res.json();
}
