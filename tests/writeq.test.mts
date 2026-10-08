// The write queue's rules (clock in/out, receipts, trips made with no signal).
// Run: node --experimental-strip-types tests/writeq.test.mts
import {
  applyWrite,
  backoffMs,
  isDueWrite,
  isMine,
  newWrite,
  SERVER_WINDOW_MS,
  wakeWrite,
  type WqItem,
} from "../src/lib/core/writeq-core.ts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};

const T0 = 1_000_000;
const item = (over: Partial<WqItem> = {}): WqItem => ({
  ...newWrite({
    id: "w-1",
    rep: "juan",
    screen: "expenses/hours",
    label: "Hours, 2026-10-08",
    path: "/api/expenses/hours",
    key: "k-1",
    json: { date: "2026-10-08" },
    now: T0,
  }),
  ...over,
});
const ctx = (over: Partial<{ now: number; rand: number; sentOnline: boolean; sentAt: number }> = {}) => ({
  now: T0,
  rand: 0.5,
  sentOnline: false,
  sentAt: T0,
  ...over,
});

// 1. A landed write is done; its result goes back to the screen.
{
  const r = applyWrite(item(), { type: "ok", result: { hoursWorked: 8 } }, ctx());
  t("1 ok is done with the result", r.done && (r.result as { hoursWorked: number }).hoursWorked === 8);
}

// 2. No signal at all: kept, plain backoff, no hold.
{
  const r = applyWrite(item(), { type: "network" }, ctx({ sentOnline: false }));
  t("2 kept", !r.done);
  if (!r.done) {
    t("2 one attempt, 5s, no hold", r.item.attempts === 1 && r.item.nextAt === T0 + 5000 && r.item.holdUntil === 0 && r.item.offline);
    t("2 not due before its backoff", !isDueWrite(r.item, T0 + 4000) && isDueWrite(r.item, T0 + 5000));
  }
}

// 3. Lost mid-request with signal: held past the server's window, and the
//    resend carries the same key, so the server replays instead of refiling.
{
  const r = applyWrite(item(), { type: "network" }, ctx({ sentOnline: true }));
  if (!r.done) {
    t("3 held for the server window", r.item.holdUntil === T0 + SERVER_WINDOW_MS && r.item.nextAt === T0 + SERVER_WINDOW_MS);
    t("3 a reconnect cannot jump the hold", !isDueWrite(wakeWrite(r.item, T0 + 1000, false), T0 + 1000));
    t("3 the key never changes across retries", r.item.key === "k-1");
  } else t("3 kept", false);
}

// 4. 5xx, 401 and 429 retry; the backoff climbs and caps at 10 minutes.
{
  for (const status of [500, 502, 503, 401, 429]) {
    const r = applyWrite(item(), { type: "http", status, error: "x" }, ctx());
    t(`4 ${status} is retried, not failed`, !r.done && !r.item.failed && r.item.attempts === 1);
  }
  let it = item();
  const gaps: number[] = [];
  let now = T0;
  for (let i = 0; i < 8; i++) {
    const r = applyWrite(it, { type: "http", status: 500, error: "Sheets down" }, ctx({ now }));
    if (r.done) break;
    gaps.push(Math.round((r.item.nextAt - now) / 1000));
    now = r.item.nextAt;
    it = r.item;
  }
  t("4 backoff 5s,15s,30s,1m,2m,5m,10m,10m", JSON.stringify(gaps) === JSON.stringify([5, 15, 30, 60, 120, 300, 600, 600]), gaps);
  t("4 the server's reason is kept on the item", it.lastError === "Sheets down");
  t("4 jitter within 10%", backoffMs(1, 0) === 4500 && backoffMs(1, 1) === 5500);
}

// 5. A refusal: kept with the reason, never due by itself, Try again un-fails it.
{
  const r = applyWrite(item(), { type: "http", status: 400, error: "date is required." }, ctx());
  t("5 400 is failed and kept", !r.done && r.item.failed === "date is required.");
  if (!r.done) {
    t("5 a failed write is never due", !isDueWrite(r.item, T0 + 1e9));
    t("5 a reconnect does not resend it", !isDueWrite(wakeWrite(r.item, T0, false), T0));
    const again = wakeWrite(r.item, T0, true);
    t("5 Try again sends it once more", isDueWrite(again, T0) && again.failed === null);
  }
}

// 6. One rep's write is never sent under the other rep's session.
{
  t("6 own write is mine", isMine({ rep: "juan" }, "juan"));
  t("6 the other rep's write is not", !isMine({ rep: "kyle" }, "juan") && !isMine({ rep: "kyle" }, null));
  t("6 a write saved before reps were recorded goes with whoever is signed in", isMine({}, "kyle") && isMine({ rep: null }, "juan"));
}

if (failures) {
  console.error(`writeq: ${failures} failing`);
  process.exitCode = 1;
} else console.log("writeq: all cases pass");
