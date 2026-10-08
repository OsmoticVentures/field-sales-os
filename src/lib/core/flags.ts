/**
 * Per-rep switches on the server: rep-flags.ts's defaults with nb_flags rows
 * laid over them (rep-flags.ts says how). One small read a minute per server
 * instance at most, so a flip takes effect within a minute and a tap never
 * waits on it twice.
 *
 * FAILS TO THE LAST KNOWN ANSWER, THEN TO THE FILE. A read that errors (the
 * table not created yet, the database briefly away) keeps the rows from the
 * last good read; with none, the file alone decides. A flag never flips
 * because a read failed.
 */
import "server-only";
import { resolveFlags, type FlagRow } from "./rep-flags";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

const TTL_MS = 60_000;
let memo: { at: number; rows: FlagRow[] } | null = null;
let inflight: Promise<FlagRow[]> | null = null;

async function read(): Promise<FlagRow[]> {
  const last = memo?.rows ?? [];
  if (!SB_URL || !SB_KEY) return last;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/nb_flags?select=flag,rep,value&limit=1000`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      cache: "no-store",
    });
    if (!res.ok) return last;
    return (await res.json()) as FlagRow[];
  } catch {
    return last;
  }
}

async function rows(): Promise<FlagRow[]> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.rows;
  inflight ??= read()
    .then((r) => {
      memo = { at: Date.now(), rows: r };
      return r;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Every switch on for this rep, sorted. */
export async function flagsFor(userId: string | null | undefined): Promise<string[]> {
  return resolveFlags(userId, await rows());
}
