// The visit outbox's state machine, against a fake phone store and a fake
// server. Run: node --experimental-strip-types tests/outbox.test.mts
import {
  advance,
  backoffMs,
  isDue,
  newItem,
  nextStep,
  pickAccount,
  pickType,
  waitsForType,
  wake,
  type Deps,
  type OutboxItem,
  type Outcome,
  type Req,
} from "../src/lib/core/outbox-core.ts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};

/** The phone store: what survives a restart is only what was saved. */
function fakeWorld(handler: (req: Req, n: number) => Outcome | "throw") {
  const disk = new Map<string, OutboxItem>();
  const sent: Req[] = [];
  let clock = 1_000_000;
  let online = true;
  const deps: Deps = {
    send: async (req) => {
      sent.push(req);
      const r = handler(req, sent.length);
      if (r === "throw") throw new TypeError("Load failed");
      return r;
    },
    save: async (it) => void disk.set(it.id, structuredClone(it)),
    remove: async (id) => void disk.delete(id),
    now: () => clock,
    rand: () => 0.5,
    online: () => online,
  };
  return {
    disk,
    sent,
    deps,
    tick: (ms: number) => (clock += ms),
    now: () => clock,
    setOnline: (v: boolean) => (online = v),
    /** A cold start: the item as the disk has it, nothing from memory. */
    reload: (id: string) => structuredClone(disk.get(id)!),
  };
}

const filed = (over: Record<string, unknown> = {}): Outcome => ({
  type: "ok",
  result: {
    ok: true,
    needsAccount: false,
    touchpoint_id: "tp-1",
    accountName: "Green Earth",
    accountId: "acc-1",
    activityId: 77,
    summary: "Met the buyer",
    peopleAdded: 0,
    peopleUpdated: 0,
    hubspotFiled: true,
    hubspotNoteId: "n-1",
    hubspotError: null,
    ...over,
  },
});
const ok = (result: unknown = {}): Outcome => ({ type: "ok", result });
const photo = { bytes: new Uint8Array([1, 2, 3]).buffer, type: "image/jpeg", name: "p.jpg" };

function enqueue(world: ReturnType<typeof fakeWorld>, over: Partial<Parameters<typeof newItem>[0]> = {}) {
  const it = newItem({ id: "item-1", text: "Met the buyer at Green Earth", now: world.now(), ...over });
  world.disk.set(it.id, structuredClone(it));
  return it;
}

// 1. Clean path with a HubSpot miss on the first file: kept until refile confirms.
{
  let refiles = 0;
  const w = fakeWorld((req) => {
    if (req.path === "/api/visit/touchpoint") return filed({ hubspotFiled: false, hubspotNoteId: null, hubspotError: "Not filed to HubSpot yet." });
    if (req.path === "/api/visit/refile") return ++refiles === 1 ? ok({ hubspotFiled: false, hubspotNoteId: null, hubspotError: "Not filed to HubSpot yet." }) : ok({ hubspotFiled: true, hubspotNoteId: "n-9", hubspotError: null });
    return ok();
  });
  const it = enqueue(w, { grade: "B", readiness: "hot", photo });
  const r1 = await advance(it, w.deps);
  t("1 filed but HubSpot unconfirmed: still on disk", !r1.removed && w.disk.has(it.id));
  const d1 = w.disk.get(it.id)!;
  t("1 note filed, read and photo done in the same pass", d1.filed && d1.readDone && d1.photoDone && d1.hubspot === "pending", d1);
  t("1 one failed pass = one attempt, 5s backoff", d1.attempts === 1 && d1.nextAt === w.now() + 5000, d1);
  t("1 touchpoint keyed by item id", w.sent[0].key === "item-1");
  t("1 read keyed item:read, photo keyed item:photo", w.sent.some((s) => s.key === "item-1:read") && w.sent.some((s) => s.form?.idempotency_key === "item-1:photo"));
  t("1 not due before its backoff", !isDue(d1, w.now() + 4000) && isDue(d1, w.now() + 5000));
  w.tick(5000);
  const r2 = await advance(w.reload(it.id), w.deps);
  t("1 deleted only once HubSpot confirmed", r2.removed && !w.disk.has(it.id) && r2.item.hubspot === "done");
  t("1 second pass did not re-post the note, read or photo", w.sent.length === 5 && w.sent.slice(4).every((s) => s.path === "/api/visit/refile"), w.sent.map((s) => s.path));
}

// 2. HubSpot keeps failing: never deleted, backoff climbs and caps at 10m.
{
  const w = fakeWorld((req) =>
    req.path === "/api/visit/touchpoint" ? filed({ hubspotFiled: false, hubspotError: "Not filed to HubSpot yet." }) : ok({ hubspotFiled: false, hubspotError: "Not filed to HubSpot yet." }),
  );
  let it: OutboxItem = enqueue(w);
  const gaps: number[] = [];
  for (let i = 0; i < 9; i++) {
    const r = await advance(it, w.deps);
    t(`2 pass ${i + 1} kept`, !r.removed && w.disk.has(it.id));
    gaps.push(Math.round((r.item.nextAt - w.now()) / 1000));
    w.tick(r.item.nextAt - w.now());
    it = w.reload(it.id);
  }
  t("2 backoff 5s,15s,30s,1m,2m,5m,10m,10m,10m", JSON.stringify(gaps) === JSON.stringify([5, 15, 30, 60, 120, 300, 600, 600, 600]), gaps);
  t("2 jitter stays within 10%", backoffMs(1, 0) === 4500 && backoffMs(1, 1) === 5500);
}

// 3. No connection: kept, nothing filed, retried; a request that may have
//    reached the server is not resent inside the server's 60s window.
{
  const w = fakeWorld(() => "throw");
  const it = enqueue(w);
  const r = await advance(it, w.deps);
  const d = w.disk.get(it.id)!;
  t("3 network failure keeps the item", !r.removed && !d.filed && d.offline && d.attempts === 1);
  t("3 held 65s since the note may be running on the server", d.holdUntil >= w.now() + 65_000 && !isDue(d, w.now() + 30_000));
  t("3 Try now cannot jump the hold", !isDue(wake(d, w.now()), w.now()));

  const w2 = fakeWorld(() => "throw");
  w2.setOnline(false);
  const it2 = enqueue(w2);
  await advance(it2, w2.deps);
  const d2 = w2.disk.get(it2.id)!;
  t("3 with no signal at all, plain 5s backoff, no hold", d2.holdUntil === 0 && d2.nextAt === w2.now() + 5000, d2);

  // 5xx and 401 retry too.
  for (const status of [500, 502, 401, 422]) {
    const w3 = fakeWorld(() => ({ type: "http", status, error: "x" }));
    const i3 = enqueue(w3);
    const r3 = await advance(i3, w3.deps);
    t(`3 ${status} is retried, not parked`, !r3.removed && !r3.item.parked && r3.item.attempts === 1);
  }
}

// 4. Not sure which store: parked, never deleted; one tap files it with the parse.
{
  const w = fakeWorld((req, n) => {
    if (n === 1)
      return ok({ ok: true, needsAccount: true, summary: "s", businessNameGuess: "Sprouts", matchAccountId: "acc-7", matchAccountName: "Sprouts Irvine", candidates: [{ id: "acc-8", name: "Sprouts Tustin", city: "Tustin" }], parsed: { p: 1 } });
    return filed({ accountId: "acc-7", accountName: "Sprouts Irvine" });
  });
  const it = enqueue(w);
  const r = await advance(it, w.deps);
  const d = w.disk.get(it.id)!;
  t("4 parked as needs-account, kept on disk", !r.removed && d.parked === "needs-account" && d.needsAccount?.candidates.length === 1);
  t("4 parked is never due, even by Try now", !isDue(d, w.now() + 1e9) && !isDue(wake(d, w.now()), w.now() + 1e9) && nextStep(d) === null);
  const picked = pickAccount(w.reload(it.id), { id: "acc-7", name: "Sprouts Irvine" }, w.now());
  const r2 = await advance(picked, w.deps);
  const body = w.sent[1].json as Record<string, unknown>;
  t("4 the pick posts with its own key and the saved parse", w.sent[1].key === "item-1:acc-7" && body.accountIdHint === "acc-7" && (body.parsed as { p: number }).p === 1);
  t("4 filed and complete after the pick", r2.removed && !w.disk.has(it.id));
}

// 5. New company: create it from the note's name, then file to it.
{
  const w = fakeWorld((req, n) => {
    if (n === 1) return ok({ ok: true, needsAccount: true, summary: "s", businessNameGuess: "Leaf & Root", matchAccountId: null, matchAccountName: null, candidates: [], parsed: { q: 2 } });
    if (req.path === "/api/visit/new-account") return ok({ accountId: "acc-new", accountName: "Leaf & Root" });
    return filed({ accountId: "acc-new", accountName: "Leaf & Root" });
  });
  const it = enqueue(w, { newCompany: true });
  const r = await advance(it, w.deps);
  t("5 new-account keyed item:new:<name>", w.sent[1].key === "item-1:new:leaf & root");
  t("5 then filed to the new account with the parse", w.sent[2].key === "item-1:acc-new" && (w.sent[2].json as { parsed: { q: number } }).parsed.q === 2);
  t("5 filed, then waits for the new store's type", !r.removed && r.item.filed && waitsForType(r.item));

  const w2 = fakeWorld(() => ok({ ok: true, needsAccount: true, summary: "s", businessNameGuess: null, matchAccountId: null, matchAccountName: null, candidates: [], parsed: {} }));
  const it2 = enqueue(w2, { newCompany: true });
  await advance(it2, w2.deps);
  t("5 no name to create from: parked, kept", w2.disk.get(it2.id)!.parked === "needs-account");
}

// 6. Restart: resume at the saved stage, never re-post a finished one.
{
  let photoTries = 0;
  const w = fakeWorld((req) => {
    if (req.path === "/api/visit/touchpoint") return filed();
    if (req.path === "/api/visit/attach") return ++photoTries === 1 ? "throw" : ok({ attachments: [] });
    return ok();
  });
  const it = enqueue(w, { photo });
  await advance(it, w.deps);
  t("6 after the first run: filed, photo pending", w.disk.get(it.id)!.filed && !w.disk.get(it.id)!.photoDone);
  // App killed. Cold start from the disk alone.
  const cold = w.reload(it.id);
  w.tick(10 * 60_000);
  const before = w.sent.length;
  const r = await advance(cold, w.deps);
  const after = w.sent.slice(before).map((s) => s.path);
  t("6 resumed at the photo only", JSON.stringify(after) === JSON.stringify(["/api/visit/attach"]), after);
  t("6 photo survived the restart as bytes", w.sent[before].form?.photo.bytes.byteLength === 3);
  t("6 complete", r.removed && !w.disk.has(it.id));

  // A crash after the server filed but before the save: same key resent,
  // so the server's idempotency guard replays instead of filing twice.
  const w2 = fakeWorld(() => filed());
  const it2 = enqueue(w2);
  const keys = [nextStep(it2)!.req.key, nextStep(w2.reload(it2.id))!.req.key];
  t("6 a resend after a lost save uses the same key", keys[0] === keys[1] && keys[0] === "item-1");
}

// 7. CRM filing off and field notes complete; HubSpot refusals stay.
{
  const w = fakeWorld(() => filed({ hubspotFiled: false, hubspotNoteId: null, hubspotError: "CRM filing off" }));
  const r = await advance(enqueue(w), w.deps);
  t("7 CRM filing off completes, no refile", r.removed && r.item.hubspot === "off" && w.sent.length === 1);

  const w2 = fakeWorld(() => filed({ isFieldNote: true, activityId: null, accountId: null, accountName: null, hubspotFiled: false, hubspotError: null }));
  const r2 = await advance(enqueue(w2, { kind: "field_note", grade: "A" }), w2.deps);
  t("7 field note completes, HubSpot n/a, no read without an account", r2.removed && r2.item.hubspot === "n/a" && w2.sent.length === 1);

  const w3 = fakeWorld((req) =>
    req.path === "/api/visit/touchpoint"
      ? filed({ hubspotFiled: false, hubspotError: "account 1 (X) is not linked to a portal company." })
      : ok({ hubspotFiled: false, hubspotError: "account 1 (X) is not linked to a portal company." }),
  );
  const it3 = enqueue(w3);
  const r3 = await advance(it3, w3.deps);
  t("7 a HubSpot refusal is kept, flagged, and retried", !r3.removed && w3.disk.has(it3.id) && Boolean(r3.item.hubspotRefused) && r3.item.attempts === 1);
}

// 8. A request that cannot succeed: parked with its reason, never deleted.
{
  const w = fakeWorld(() => ({ type: "http", status: 400, error: "Nothing to record." }));
  const it = enqueue(w);
  const r = await advance(it, w.deps);
  const d = w.disk.get(it.id)!;
  t("8 400 parks as rejected with the reason, kept", !r.removed && d.parked === "rejected" && d.lastError === "Nothing to record.");
  t("8 Try now un-parks a rejected item", isDue(wake(d, w.now()), w.now()));
}

// 9. New company: the store is found near the phone, then waits, filed, for its type.
{
  const w = fakeWorld((req, n) => {
    if (n === 1) return ok({ ok: true, needsAccount: true, summary: "s", businessNameGuess: "JONS Torrance", matchAccountId: null, matchAccountName: null, candidates: [], parsed: {} });
    if (req.path === "/api/visit/new-account") return ok({ accountId: "acc-j", accountName: "JONS Torrance", channel: "grocery" });
    if (req.path === "/api/visit/account-type") return ok({ channel: "specialty" });
    return filed({ accountId: "acc-j", accountName: "JONS Torrance" });
  });
  const it = enqueue(w, { newCompany: true, near: { lat: 33.85, lng: -118.36 } });
  const r = await advance(it, w.deps);
  const d = w.disk.get(it.id)!;
  t("9 new-account carries where the phone was", (w.sent[1].json as { near: { lat: number } }).near.lat === 33.85);
  t("9 filed, kept, waiting for its type with Places' suggestion", !r.removed && d.filed && waitsForType(d) && d.storeType?.suggested === "grocery", d.storeType);
  t("9 waiting for a type is never due and sends nothing", !isDue(d, w.now() + 1e9) && nextStep(d) === null);
  const r2 = await advance(pickType(w.reload(it.id), "specialty", w.now()), w.deps);
  const last = w.sent[w.sent.length - 1];
  t("9 the pick posts the type to the new account", last.path === "/api/visit/account-type" && (last.json as { channel: string; account_id: string }).channel === "specialty" && (last.json as { account_id: string }).account_id === "acc-j");
  t("9 complete once the type is on", r2.removed && !w.disk.has(it.id));

  const other = pickType(d, null, w.now());
  t("9 Other completes with nothing sent", other.storeType?.done === true && nextStep(other) === null);

  const w2 = fakeWorld(() => filed());
  const r3 = await advance(enqueue(w2), w2.deps);
  t("9 a store already in the book is never asked its type", r3.removed && !r3.item.storeType);
}

if (failures) {
  console.error(`outbox: ${failures} failing`);
  process.exitCode = 1;
} else console.log("outbox: all cases pass");
