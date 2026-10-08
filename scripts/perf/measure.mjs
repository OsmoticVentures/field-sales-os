// Measure each data-backed screen and read against fake-postgrest.mjs.
//
//   pnpm build && node scripts/perf/measure.mjs [--json out.json]
//
// For each target: a fresh `next start` (so every in-memory memo is cold),
// one cold request metered at the fake database (requests, rows, bytes),
// then five warm requests timed (median). Signs in as Juan with a session
// cookie minted from a throwaway local secret; no real PIN or key is used.
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";

const PORT = 3999, DB = 54321;
const SECRET = "perf-local-only-secret";
const TARGETS = [
  "/nb/clients",
  "/nb/prospect",
  "/nb/reports",
  "/nb/outbound",
  "/nb/account/a_000005",
  "/nb/api/route/state",
  "/nb/api/route/map",
  "/nb/api/route/returns",
];

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const payload = `juan.${Date.now() + 8 * 3600_000}`;
const cookie = `nb_session=${payload}.${b64url(createHmac("sha256", SECRET).update(payload).digest())}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(url) {
  for (let i = 0; i < 100; i++) {
    try { await fetch(url); return; } catch { await sleep(100); }
  }
  throw new Error(`no answer from ${url}`);
}

const db = spawn(process.execPath, ["scripts/perf/fake-postgrest.mjs", String(DB)], { stdio: "ignore" });
await up(`http://127.0.0.1:${DB}/__meter`);

const env = { ...process.env, NB_SUPABASE_URL: `http://127.0.0.1:${DB}`, NB_SUPABASE_SERVICE_ROLE_KEY: "fake", NB_SESSION_SECRET: SECRET, NB_PIN: "", PORT: String(PORT) };
const results = [];
for (const path of TARGETS) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/nb/api/health`);
    throw new Error(`port ${PORT} is already serving; stop that server first`);
  } catch (e) {
    if (String(e).includes("already serving")) throw e;
  }
  const app = spawn("node_modules/.bin/next", ["start", "-p", String(PORT)], { env, stdio: "ignore", detached: true });
  await up(`http://127.0.0.1:${PORT}/nb/api/health`);
  await fetch(`http://127.0.0.1:${DB}/__meter`); // reset
  const get = async () => {
    const t = performance.now();
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { cookie }, redirect: "manual" });
    const text = await res.text();
    return { ms: performance.now() - t, status: res.status, bytes: Buffer.byteLength(text), text };
  };
  const cold = await get();
  const meter = await (await fetch(`http://127.0.0.1:${DB}/__meter`)).json();
  const warm = [];
  for (let i = 0; i < 5; i++) warm.push((await get()).ms);
  warm.sort((a, b) => a - b);
  // What the screen shows, for an equality check across a change: JSON as
  // is, a page as its visible text (build ids and script tags vary).
  const shown = path.includes("/api/") ? cold.text : cold.text.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const byTable = {};
  for (const m of meter) {
    const t = (byTable[m.table] ??= { reqs: 0, rows: 0, bytes: 0, maxUrl: 0 });
    t.reqs++; t.rows += m.rows; t.bytes += m.bytes; t.maxUrl = Math.max(t.maxUrl, m.urlBytes);
  }
  results.push({
    path, status: cold.status, coldMs: Math.round(cold.ms), warmMedianMs: Math.round(warm[2]), responseBytes: cold.bytes,
    dbRequests: meter.length, dbBytes: meter.reduce((s, m) => s + m.bytes, 0), byTable,
    shownHash: createHash("sha256").update(shown).digest("hex").slice(0, 12),
  });
  process.kill(-app.pid); // the whole group: next start forks the server
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/nb/api/health`); await sleep(100); } catch { break; }
  }
}
db.kill();

console.log("path\tstatus\tcold_ms\twarm_ms\tresponse_kB\tdb_reqs\tdb_kB\tshown");
for (const r of results) console.log(`${r.path}\t${r.status}\t${r.coldMs}\t${r.warmMedianMs}\t${(r.responseBytes / 1024).toFixed(1)}\t${r.dbRequests}\t${(r.dbBytes / 1024).toFixed(1)}\t${r.shownHash}`);
const out = process.argv.indexOf("--json");
if (out > 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify(results, null, 2));
