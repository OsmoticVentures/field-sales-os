// A stand-in for Supabase's PostgREST, for measuring this app locally without
// production credentials. Serves synthetic rows sized to the real book
// (scripts/perf/seed.mjs) and meters every read: table, rows, bytes.
//
//   node scripts/perf/fake-postgrest.mjs [port]
//   GET /__meter        -> the meter since the last reset, then resets it
//
// Supports what the dals use: select (plain columns, embeds come back null),
// eq/neq/gt/gte/lt/lte/is/in/like/ilike/match/imatch, not.<op>, or=(...),
// order (asc/desc, nullsfirst/nullslast), limit/offset. Writes are accepted
// and discarded; storage and rpc answer empty.
import http from "node:http";
import { seed } from "./seed.mjs";

const PORT = Number(process.argv[2] ?? 54321);
const db = seed();
let meter = [];

function splitTop(s) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function lit(v) {
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  return v.replace(/^"(.*)"$/, "$1");
}

function cmp(a, b) {
  if (a == null || b == null) return 0;
  const na = Number(a), nb = Number(b);
  if (typeof a === "number" || (!Number.isNaN(na) && !Number.isNaN(nb) && typeof a !== "string")) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function test(row, col, expr) {
  let neg = false;
  if (expr.startsWith("not.")) { neg = true; expr = expr.slice(4); }
  const dot = expr.indexOf(".");
  const op = expr.slice(0, dot), val = expr.slice(dot + 1);
  const v = row[col];
  let ok;
  switch (op) {
    case "eq": ok = v != null && String(v) === String(lit(val)); break;
    case "neq": ok = v != null && String(v) !== String(lit(val)); break;
    case "gt": ok = v != null && cmp(v, val) > 0; break;
    case "gte": ok = v != null && cmp(v, val) >= 0; break;
    case "lt": ok = v != null && cmp(v, val) < 0; break;
    case "lte": ok = v != null && cmp(v, val) <= 0; break;
    case "is": ok = lit(val) === null ? v == null : v === lit(val); break;
    case "in": ok = v != null && val.replace(/^\(|\)$/g, "").split(",").map(lit).map(String).includes(String(v)); break;
    case "like": case "ilike": {
      const re = new RegExp(`^${val.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/[*%]/g, ".*")}$`, op === "ilike" ? "is" : "s");
      ok = v != null && re.test(String(v)); break;
    }
    case "match": case "imatch": ok = v != null && new RegExp(val, op === "imatch" ? "i" : "").test(String(v)); break;
    default: throw new Error(`fake-postgrest: unsupported op ${op}`);
  }
  return neg ? !ok : ok;
}

function orTest(row, group) {
  return splitTop(group.replace(/^\(|\)$/g, "")).some((term) => {
    const dot = term.indexOf(".");
    return test(row, term.slice(0, dot), term.slice(dot + 1));
  });
}

function query(table, params) {
  let rows = db[table];
  if (!rows) return { status: 404, body: { message: `relation ${table} does not exist` } };
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
    if (k === "or") rows = rows.filter((r) => orTest(r, v));
    else rows = rows.filter((r) => test(r, k, v));
  }
  const order = params.get("order");
  if (order) {
    const keys = order.split(",").map((o) => {
      const [col, ...mods] = o.split(".");
      return { col, desc: mods.includes("desc"), nullsFirst: mods.includes("nullsfirst") || (mods.includes("desc") && !mods.includes("nullslast")) };
    });
    rows = [...rows].sort((a, b) => {
      for (const { col, desc, nullsFirst } of keys) {
        const x = a[col], y = b[col];
        if (x == null && y == null) continue;
        if (x == null) return nullsFirst ? -1 : 1;
        if (y == null) return nullsFirst ? 1 : -1;
        const c = cmp(x, y);
        if (c) return desc ? -c : c;
      }
      return 0;
    });
  }
  const offset = Number(params.get("offset") ?? 0);
  const limit = Math.min(Number(params.get("limit") ?? 1000), 1000); // PostgREST max-rows
  rows = rows.slice(offset, offset + limit);
  const select = params.get("select") ?? "*";
  const items = splitTop(select);
  const out = rows.map((r) => {
    if (items.length === 1 && items[0] === "*") return r;
    const o = {};
    for (const it of items) {
      if (it === "*") Object.assign(o, r);
      else if (it.includes("(")) o[it.slice(0, it.indexOf("(")).split(":")[0].split("!")[0]] = null;
      else { const [alias, col] = it.includes(":") ? it.split(":") : [it, it]; o[alias] = r[col] ?? null; }
    }
    return o;
  });
  return { status: 200, body: out };
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/__meter") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(meter));
      meter = [];
      return;
    }
    const m = /^\/rest\/v1\/([a-z_0-9]+)$/.exec(url.pathname);
    let status = 200, body = [];
    if (m && (req.method === "GET" || req.method === "HEAD")) ({ status, body } = query(m[1], url.searchParams));
    else if (!m) status = url.pathname.startsWith("/storage/") ? 404 : 200;
    const text = JSON.stringify(body);
    if (req.method === "GET") meter.push({ table: m?.[1] ?? url.pathname, rows: Array.isArray(body) ? body.length : 0, bytes: Buffer.byteLength(text), urlBytes: req.url.length });
    req.resume();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`fake-postgrest on :${PORT}`));
