/**
 * A phone note read on Juan's Max plan when his laptop is open (Juan,
 * 2026-10-22: "Laptop if open, else now").
 *
 * The Mac's reader (bridges/nutribiotic/note_reader.py) polls nb_mac_poll()
 * every few seconds while it is awake. If it polled just now, the note goes
 * into nb_note_reads and this waits for its read; the reader runs `claude -p`
 * against extractionSpec() and writes the parse back. Any miss (lid shut, no
 * claim in time, a failed or slow read) returns null and the caller reads the
 * note on the API key as before. Nothing here can stop a note from filing.
 */
import "server-only";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

/** The Mac polls every 4s; seen within this window means awake. */
const AWAKE_MS = 12_000;
/** A claim takes at most one poll; no claim by now means it went to sleep. */
const CLAIM_MS = 9_000;
/** A Max read takes ~7s; past this the phone has waited long enough. */
const READ_MS = 35_000;
const POLL_MS = 1_000;

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
    signal: AbortSignal.timeout(4_000),
  });
}

async function macAwake(): Promise<boolean> {
  const res = await sb("nb_mac_presence?id=eq.1&select=last_seen");
  if (!res.ok) return false;
  const [row] = (await res.json()) as { last_seen: string }[];
  return Boolean(row) && Date.now() - new Date(row.last_seen).getTime() < AWAKE_MS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The model's raw parse of `text`, read on the Mac, or null to read it here. */
export async function readOnMac(text: string): Promise<unknown | null> {
  if (!SB_URL || !SB_KEY) return null;
  try {
    if (!(await macAwake())) return null;
    const created = await sb("nb_note_reads?select=id", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ text }),
    });
    if (!created.ok) return null;
    const [{ id }] = (await created.json()) as { id: string }[];

    const start = Date.now();
    while (Date.now() - start < READ_MS) {
      await sleep(POLL_MS);
      const res = await sb(`nb_note_reads?id=eq.${id}&select=status,parsed`).catch(() => null);
      if (!res?.ok) continue;
      const [row] = (await res.json()) as { status: string; parsed: unknown }[];
      if (row?.status === "done") return row.parsed ?? null;
      if (row?.status === "failed") return null;
      if (row?.status === "pending" && Date.now() - start > CLAIM_MS) break;
    }
    // Not read in time: mark it so a late read is never mistaken for a live one.
    await sb(`nb_note_reads?id=eq.${id}&status=in.(pending,reading)`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: "abandoned" }),
    }).catch(() => null);
    return null;
  } catch {
    return null;
  }
}
