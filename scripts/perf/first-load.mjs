// Usage: pnpm build && node scripts/perf/first-load.mjs .next
// Per app page: the unique JS chunks a cold load fetches (root main files +
// every entryJSFiles list in that page's client reference manifest), raw and gzip.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import vm from "node:vm";
const dot = process.argv[2];
const bm = JSON.parse(fs.readFileSync(path.join(dot, "build-manifest.json"), "utf8"));
const root = new Set([...(bm.rootMainFiles || []), ...(bm.polyfillFiles || []).filter(() => false)]);
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f === "page_client-reference-manifest.js") files.push(p); } })(path.join(dot, "server/app"));
const sz = new Map();
const size = (f) => { if (!sz.has(f)) { const b = fs.readFileSync(path.join(dot, f.replace(/^static/, "static"))); sz.set(f, [b.length, zlib.gzipSync(b, { level: 9 }).length]); } return sz.get(f); };
const rows = [];
for (const f of files) {
  const ctx = { globalThis: {} }; ctx.self = ctx.globalThis;
  vm.runInNewContext(fs.readFileSync(f, "utf8"), ctx);
  const m = ctx.globalThis.__RSC_MANIFEST;
  for (const [route, man] of Object.entries(m)) {
    const set = new Set(root);
    for (const list of Object.values(man.entryJSFiles || {})) for (const j of list) set.add(j);
    let raw = 0, gz = 0;
    for (const j of set) { const p = j.startsWith("/_next/") ? j.slice(7) : j.replace(/^\/?_next\//, ""); try { const [r, g] = size(p); raw += r; gz += g; } catch {} }
    rows.push([route, set.size, raw, gz]);
  }
}
rows.sort((a, b) => b[3] - a[3]);
console.log("route\tchunks\traw_kB\tgzip_kB");
for (const [r, n, raw, gz] of rows) if (!r.includes("/api/")) console.log(`${r}\t${n}\t${(raw / 1024).toFixed(1)}\t${(gz / 1024).toFixed(1)}`);
