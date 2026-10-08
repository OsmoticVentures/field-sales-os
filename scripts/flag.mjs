#!/usr/bin/env node
/**
 * Flip a per-rep switch in nb_flags (supabase/0003_rep_flags.sql) without a
 * deploy. The app picks it up within a minute.
 *
 *   node scripts/flag.mjs list
 *   node scripts/flag.mjs set <flag> <rep|*> on|off [note]
 *   node scripts/flag.mjs clear <flag> <rep|*>        back to rep-flags.ts
 *
 * <rep> is an nb_users id (juan, kyle) or * for every rep; a rep's own row
 * beats the * row. Credentials: NB_SUPABASE_URL and
 * NB_SUPABASE_SERVICE_ROLE_KEY from the environment, else from the agency's
 * nutribiotic/.env. Prints rows, never a key.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function env(name) {
  if (process.env[name]) return process.env[name];
  const candidates = [
    join(here, "..", ".env.local"),
    join(here, "..", "..", "..", "nutribiotic", ".env"),
    "/Users/juanarenas/agency/nutribiotic/.env",
  ];
  for (const file of candidates) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const m = text.match(new RegExp(`^${name}=(.*)$`, "m"));
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

const url = env("NB_SUPABASE_URL");
const key = env("NB_SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("NB_SUPABASE_URL and NB_SUPABASE_SERVICE_ROLE_KEY are not set.");
  process.exit(1);
}
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

async function call(path, init = {}) {
  const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : null;
}

const [cmd, flag, rep, value, ...note] = process.argv.slice(2);
const FLAG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

if (cmd === "list") {
  const rows = await call("nb_flags?select=flag,rep,value,note,updated_at&order=flag.asc,rep.asc");
  if (!rows.length) console.log("No rows. Every flag follows rep-flags.ts.");
  for (const r of rows) console.log(`${r.flag}  ${r.rep}  ${r.value ? "on" : "off"}  ${r.updated_at}${r.note ? `  ${r.note}` : ""}`);
} else if (cmd === "set" && flag && rep && (value === "on" || value === "off")) {
  if (!FLAG.test(flag)) {
    console.error("A flag name is kebab-case: no-area-filters.");
    process.exit(1);
  }
  const row = { flag, rep, value: value === "on", note: note.join(" ") || null, updated_at: new Date().toISOString() };
  const out = await call("nb_flags?on_conflict=flag,rep", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify([row]),
  });
  console.log(`${out[0].flag}  ${out[0].rep}  ${out[0].value ? "on" : "off"}`);
} else if (cmd === "clear" && flag && rep) {
  const out = await call(`nb_flags?flag=eq.${encodeURIComponent(flag)}&rep=eq.${encodeURIComponent(rep)}`, {
    method: "DELETE",
    headers: { Prefer: "return=representation" },
  });
  console.log(out.length ? `${flag}  ${rep}  back to rep-flags.ts` : "No such row.");
} else {
  console.error("Usage: flag.mjs list | set <flag> <rep|*> on|off [note] | clear <flag> <rep|*>");
  process.exit(1);
}
