// The note path's rules: what the server files raw, the HubSpot retry's
// backoff and its retry row, and what the phone hands its native copy. The
// build runs this (package.json prebuild): a change that would strand a note
// does not deploy. Run: node --experimental-strip-types tests/note-path.test.mts
import { HUBSPOT_BACKOFF_MIN, hubspotBackoff, rawKind, retryRow } from "../src/lib/features/visit/note-path-core.ts";
import { advance, nativeHandoff, newItem, type Deps, type OutboxItem, type Outcome, type Req } from "../src/lib/core/outbox-core.ts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};

// 1. Raw filing: the door decides the kind; a field note is never filed unread.
t("1 a plain note files raw as a visit", rawKind(null) === "visit" && rawKind(undefined) === "visit");
t("1 the call, email and meeting doors keep their kind", rawKind("call") === "call" && rawKind("email") === "email_out" && rawKind("meeting") === "meeting");
t("1 a field note is never filed raw", rawKind("field_note") === null);

// 2. HubSpot retry: climbs and caps, never gives up sooner than an hour of tries.
t("2 backoff climbs 10, 20, 40 minutes", hubspotBackoff(0) === 10 && hubspotBackoff(1) === 20 && hubspotBackoff(2) === 40);
t("2 backoff caps at 6 hours", hubspotBackoff(40) === 360 && hubspotBackoff(-3) === 10);
t("2 the ladder is increasing", HUBSPOT_BACKOFF_MIN.every((v, i, a) => i === 0 || v > a[i - 1]));
{
  const now = Date.UTC(2026, 10, 23, 12);
  const hit = retryRow(5, 0, { ok: true }, now);
  t("2 a filed record closes the row", hit.done_at === new Date(now).toISOString() && hit.attempts === 1 && hit.last_error === null);
  const miss = retryRow(5, 2, { ok: false, error: "HubSpot 502" }, now);
  t("2 a miss stays open with its next try", !miss.done_at && miss.next_at === new Date(now + 40 * 60_000).toISOString() && miss.attempts === 3);
  const never = retryRow(5, 0, { ok: false, error: "field_note is never filed", neverFiled: true }, now);
  t("2 a kind that never files closes, not retried", Boolean(never.done_at) && !never.next_at);
}

// 3. The native copy: every unsent note of Juan's, under the page's own key,
//    and a key is only ever reported done by a page that saw it leave.
{
  const juan = (id: string, over: Partial<OutboxItem> = {}): OutboxItem => ({ ...newItem({ id, text: `Met the buyer ${id}`, now: 1 }), rep: "juan", ...over });
  const a = juan("a");
  const b = juan("b", { parked: "rejected" });
  const c = juan("c", { pickedAccountId: "acc-9", parsed: { activity: {} } });
  const d = { ...juan("d"), rep: "kyle" };
  const e = juan("e", { filed: true, accepted: true });
  const first = nativeHandoff([a, b, c, d, e], new Set(), "juan");
  t("3 an unsent note is handed over under its own key", first.notes.length === 1 && first.notes[0].key === "a" && first.notes[0].json.text === "Met the buyer a");
  t("3 parked, picked-with-a-parse, sent and the other rep's stay the page's", !first.notes.some((n) => ["b", "c", "d", "e"].includes(n.key)));
  t("3 a fresh launch reports nothing done", first.done.length === 0);
  const after = nativeHandoff([{ ...a, filed: true, accepted: true }], new Set(["a"]), "juan");
  t("3 once the server has it, the key comes back as done", after.notes.length === 0 && after.done[0] === "a");
  const emptied = nativeHandoff([], new Set(), "juan");
  t("3 a cleared page store drops nothing from the native copy", emptied.done.length === 0);
  const kyle = nativeHandoff([{ ...a, rep: null }], new Set(), "kyle");
  t("3 a note with no rep under the other rep's session is not handed over", kyle.notes.length === 0);
}

// 4. The outbox never lets a note go before the server has it: an outage, a
//    timeout and a 5xx all keep it; only the inbox's accept removes it.
{
  const run = async (answer: Outcome | "throw") => {
    const sent: Req[] = [];
    let disk: OutboxItem | null = null;
    const deps: Deps = {
      send: async (req) => {
        sent.push(req);
        if (answer === "throw") throw new TypeError("Load failed");
        return answer;
      },
      save: async (it) => void (disk = structuredClone(it)),
      remove: async () => void (disk = null),
      now: () => 1_000_000,
      rand: () => 0.5,
      online: () => true,
    };
    const it = { ...newItem({ id: "n1", text: "Met the buyer at Green Earth", now: 1_000_000 }), rep: "juan" };
    const r = await advance(it, deps);
    return { r, disk: disk as OutboxItem | null, sent };
  };
  for (const [name, ans] of [
    ["network", { type: "network" }],
    ["503", { type: "http", status: 503, error: "Could not save that note" }],
    ["500", { type: "http", status: 500, error: null }],
    ["throw", "throw"],
  ] as const) {
    const { r, disk } = await run(ans as Outcome | "throw");
    t(`4 ${name}: the note stays on the phone, unsent`, !r.removed && !r.item.filed && Boolean(disk) && !disk!.filed);
  }
  const ok = await run({ type: "ok", result: { accepted: true, key: "n1", accountId: null, accountName: null, status: "waiting" } });
  t("4 the inbox's accept is what removes it", ok.r.removed && ok.r.item.accepted === true);
}

if (failures) {
  console.error(`note path: ${failures} failing`);
  process.exitCode = 1;
} else console.log("note path: all cases pass");
