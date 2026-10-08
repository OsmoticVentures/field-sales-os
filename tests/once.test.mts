// The once-per-key guard (src/lib/core/once.ts) behind every write that
// follows an AI step: a filed touchpoint, a HubSpot note, an outbound draft.
// Runs against a fake PostgREST (nb_idempotency_keys) and a fake HubSpot,
// both behind one mocked fetch. Nothing here reaches the network.
// Run: node --experimental-strip-types tests/once.test.mts
import { Held, makeOnce, postgrestClaimStore } from "../src/lib/core/once.ts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};

const SB = "https://sb.test";
/** Postgres prints timestamptz with microseconds; a CAS must echo it exactly. */
const pgNow = (ms = Date.now()) => new Date(ms).toISOString().replace("Z", "") + "123+00:00";
const tick = () => new Promise<void>((r) => setTimeout(r, 2));

/** nb_idempotency_keys as PostgREST serves it: a primary key on id. */
function fakeWorld() {
  const rows = new Map<string, { response: unknown; created_at: string }>();
  const hubspotPosts: unknown[] = [];
  let down = false;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    await tick(); // every request yields, so concurrent callers interleave
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.host === "api.hubapi.com") {
      hubspotPosts.push(init?.body);
      return Response.json({ id: `hs-${hubspotPosts.length}` }, { status: 201 });
    }
    if (down) throw new Error("fetch failed");
    const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
    if (method === "POST") {
      const body = JSON.parse(String(init?.body)) as { id: string; response: unknown };
      if (rows.has(body.id)) return Response.json({ code: "23505" }, { status: 409 });
      rows.set(body.id, { response: body.response, created_at: pgNow() });
      return new Response(null, { status: 201 });
    }
    if (method === "GET") {
      const r = rows.get(id);
      return Response.json(r ? [r] : []);
    }
    if (method === "PATCH") {
      const r = rows.get(id);
      const cas = url.searchParams.get("created_at");
      if (!r || (cas && r.created_at !== cas.replace(/^eq\./, ""))) return Response.json([]);
      const patch = JSON.parse(String(init?.body)) as { response: unknown; created_at?: string };
      r.response = patch.response;
      if (patch.created_at) r.created_at = patch.created_at;
      return Response.json([r]);
    }
    if (method === "DELETE") {
      rows.delete(id);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 400 });
  }) as typeof fetch;
  const server = () => makeOnce(postgrestClaimStore({ url: SB, key: "k", fetch: f }), { sleep: () => tick() });
  return { rows, hubspotPosts, f, server, setDown: (v: boolean) => (down = v) };
}

/** The HubSpot write a filing does: one POST that creates a meeting. */
const fileToHubspot = (w: ReturnType<typeof fakeWorld>) => async () => {
  const res = await w.f("https://api.hubapi.com/crm/v3/objects/meetings", { method: "POST", body: "{}" });
  return ((await res.json()) as { id: string }).id;
};

{
  const w = fakeWorld();
  const a = w.server();
  const b = w.server(); // a second server instance: its own memory, the same table
  const outs = await Promise.all([
    a("hubspot:engagement:41", fileToHubspot(w)),
    a("hubspot:engagement:41", fileToHubspot(w)),
    b("hubspot:engagement:41", fileToHubspot(w)),
  ]);
  t("double tap across two instances: one HubSpot POST", w.hubspotPosts.length === 1, w.hubspotPosts.length);
  t("every caller gets the same note id", outs.every((o) => o.result === "hs-1"));
  t("exactly one caller wrote, the rest replayed", outs.filter((o) => !o.replayed).length === 1);
  const later = await b("hubspot:engagement:41", fileToHubspot(w));
  t("a later retry replays, never writes", later.replayed && later.result === "hs-1" && w.hubspotPosts.length === 1);
}

{
  const w = fakeWorld();
  const a = w.server();
  let runs = 0;
  let err: unknown = null;
  try {
    await a("touchpoint:x", async () => {
      runs++;
      throw new Error("HubSpot 502");
    });
  } catch (e) {
    err = e;
  }
  t("a failed write throws through", err instanceof Error && runs === 1);
  t("a failed write releases its claim", !w.rows.has("once:touchpoint:x"));
  const again = await a("touchpoint:x", async () => {
    runs++;
    return "filed";
  });
  t("the retry after a failure runs fresh", again.result === "filed" && !again.replayed && runs === 2);
}

{
  const w = fakeWorld();
  // A first try that crashed mid-write: its claim is pending and old.
  w.rows.set("once:touchpoint:y", { response: { state: "pending", at: 0 }, created_at: pgNow(Date.now() - 10 * 60_000) });
  const out = await w.server()("touchpoint:y", async () => "filed");
  t("a stale pending claim is taken over", out.result === "filed" && !out.replayed);
  t("and completed", (w.rows.get("once:touchpoint:y")?.response as { state: string }).state === "done");
}

{
  const w = fakeWorld();
  // Another instance is mid-write right now and never finishes in time.
  w.rows.set("once:touchpoint:z", { response: { state: "pending", at: Date.now() }, created_at: pgNow() });
  let ran = false;
  let err: unknown = null;
  try {
    await w.server()("touchpoint:z", async () => {
      ran = true;
      return "x";
    }, { waitMs: 30 });
  } catch (e) {
    err = e;
  }
  t("a fresh pending claim is waited on, then Held, never a second write", err instanceof Held && !ran);
}

{
  const w = fakeWorld();
  const a = w.server();
  let resolveFirst: (v: string) => void = () => {};
  const first = a("touchpoint:slow", () => new Promise<string>((r) => (resolveFirst = r)));
  await tick();
  await tick();
  const second = w.server()("touchpoint:slow", async () => "second", { waitMs: 5_000 });
  await tick();
  resolveFirst("first");
  const [o1, o2] = await Promise.all([first, second]);
  t("a second instance waits for the first and replays its result", o1.result === "first" && o2.result === "first" && o2.replayed);
}

{
  const w = fakeWorld();
  w.setDown(true);
  const a = w.server();
  const outs = await Promise.all([a("k", fileToHubspot(w)), a("k", fileToHubspot(w))]);
  t("table unreachable: the write still runs", outs[0].result === "hs-1");
  t("table unreachable: same-instance double tap still one write", w.hubspotPosts.length === 1);
}

{
  const once = makeOnce(null);
  let n = 0;
  await Promise.all([once("k", async () => ++n), once("k", async () => ++n)]);
  t("no store at all: in-flight dedupe only", n === 1);
}

if (failures) {
  console.error(`once: ${failures} failing`);
  process.exitCode = 1;
} else console.log("once: all cases pass");
