#!/usr/bin/env node
/**
 * Build a staging database for ClientOS from nothing: every migration in
 * order, then a small synthetic dataset. Run from anywhere:
 *
 *   STAGING_PIN_JUAN=.... STAGING_PIN_KYLE=.... \
 *     node osmotic-ventures/field-sales-os/scripts/staging/bootstrap.mjs --ref <staging ref>
 *
 *   node .../bootstrap.mjs --ref <staging ref> --dry-run    (offline, prints the plan;
 *                                                            add --show-seed for the seed SQL)
 *
 * Inputs
 *   --ref or STAGING_SUPABASE_REF          the staging project ref (20 letters)
 *   STAGING_SUPABASE_ACCESS_TOKEN          a Supabase management token; falls back
 *                                           to SUPABASE_ACCESS_TOKEN in nutribiotic/.env
 *   STAGING_PIN_JUAN, STAGING_PIN_KYLE     the staging sign-in PINs, distinct, never
 *                                           the production ones
 *   STAGING_MIGRATIONS_DIR                 optional; defaults to the agency's
 *                                           nutribiotic/supabase/migrations
 *   AGENCY_ROOT                            optional; defaults to two levels above this repo
 *
 * Rails
 *   - Refuses the production project ref outright.
 *   - Each migration runs as one Management API query, together with the row
 *     that records it in staging_migrations, so a failure applies nothing from
 *     that file and a rerun picks up exactly where the last one stopped.
 *   - Stops on the first failing migration and names the file.
 *   - No real customer row reaches staging: a migration that inserts into a
 *     table outside SAFE_INSERT_TABLES stops the run unless a neutralizer
 *     below rewrites it. 0029's home-base row (a real street address) is the
 *     one found so far; it is replaced by a synthetic waypoint in the seed.
 *   - Every seeded account is origin 'synthetic' under one dataset id, so
 *     `delete from nb_synthetic_datasets where id = 'staging-seed-v1'` purges
 *     them all, and none carries a HubSpot company id.
 *   - Never prints a token or a PIN.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRODUCTION_REF = "giodrtaddvmkgvmzomxv";
const API = "https://api.supabase.com/v1";
const DATASET = "staging-seed-v1";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENCY = process.env.AGENCY_ROOT ? resolve(process.env.AGENCY_ROOT) : resolve(REPO, "..", "..");

/* ------------------------------------------------------------------------ */
/* Arguments                                                                 */
/* ------------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : undefined;
};

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const DRY = flag("--dry-run");
const REF = (opt("--ref") ?? process.env.STAGING_SUPABASE_REF ?? "").trim();

if (!REF) die("Give the staging project ref: --ref <ref> or STAGING_SUPABASE_REF.");
if (REF === PRODUCTION_REF) die("Refusing: that is the production project. Staging gets its own project.");
if (!/^[a-z]{20}$/.test(REF)) die(`"${REF}" does not look like a Supabase project ref (20 lowercase letters).`);

/* ------------------------------------------------------------------------ */
/* Migrations                                                                */
/* ------------------------------------------------------------------------ */

const NB_DIR = process.env.STAGING_MIGRATIONS_DIR
  ? resolve(process.env.STAGING_MIGRATIONS_DIR)
  : join(AGENCY, "nutribiotic", "supabase", "migrations");
const LOCAL_DIR = join(REPO, "supabase");

const sqlFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

if (!existsSync(NB_DIR)) die(`Migrations folder not found: ${NB_DIR}. Set STAGING_MIGRATIONS_DIR.`);

/** Tables a migration may seed with a literal row: settings singletons and
 *  labels, never a customer, a contact, an order or a person. Inserts inside
 *  function bodies that only take parameters (voice_lessons, nb_app_errors)
 *  are listed too, since the scan cannot tell a body from a top-level row. */
const SAFE_INSERT_TABLES = new Set(["nb_ui_prefs", "nb_search_groups", "voice_lessons", "nb_app_errors"]);

/** Rewrites for migrations that carry a real row. Each must match exactly
 *  once, so a migration edited later stops the run instead of slipping past. */
const NEUTRALIZERS = {
  "nutribiotic/0029_route_draft_and_home_base.sql": {
    why: "inserts the home-base waypoint with a real street address; the seed adds a synthetic one instead",
    pattern: /-- Juan's apartment\.[\s\S]*?insert into nb_accounts \([\s\S]*?on conflict \(id\) do nothing;/g,
    replacement: "-- Home-base waypoint omitted on staging; scripts/staging/bootstrap.mjs seeds a synthetic one.",
  },
};

const stripComments = (sql) => sql.replace(/--[^\n]*/g, "");

function insertTargets(sql) {
  const out = [];
  for (const m of stripComments(sql).matchAll(/\binsert\s+into\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    out.push(m[1].toLowerCase());
  }
  return out;
}

function loadMigrations() {
  const list = [
    ...sqlFiles(NB_DIR).map((f) => ({ name: `nutribiotic/${f}`, path: join(NB_DIR, f) })),
    ...(existsSync(LOCAL_DIR) ? sqlFiles(LOCAL_DIR).map((f) => ({ name: `field-sales-os/${f}`, path: join(LOCAL_DIR, f) })) : []),
  ];
  const findings = [];
  for (const m of list) {
    let sql = readFileSync(m.path, "utf8");
    const n = NEUTRALIZERS[m.name];
    if (n) {
      const hits = sql.match(n.pattern)?.length ?? 0;
      if (hits !== 1) die(`${m.name} no longer matches its neutralizer (${hits} matches). Review it before staging runs it.`);
      sql = sql.replace(n.pattern, n.replacement);
      findings.push(`${m.name}: neutralized, ${n.why}`);
    }
    if (/\bcopy\s+[a-z_."]+\s*(\([^)]*\))?\s*from\b/i.test(stripComments(sql))) {
      die(`${m.name} loads rows with COPY. Review it for real data and add a neutralizer before staging runs it.`);
    }
    const unsafe = insertTargets(sql).filter((t) => !SAFE_INSERT_TABLES.has(t));
    if (unsafe.length) {
      die(`${m.name} inserts into ${[...new Set(unsafe)].join(", ")}. Review it for real data and add a neutralizer before staging runs it.`);
    }
    m.sql = sql;
  }
  return { list, findings };
}

/* ------------------------------------------------------------------------ */
/* Synthetic seed                                                            */
/* ------------------------------------------------------------------------ */

const REPS = [
  { id: "juan", name: "Juan", ownerId: "36242368", ownerName: "Juan Arenas Martin", prefsId: 1, pinEnv: "STAGING_PIN_JUAN" },
  { id: "kyle", name: "Kyle", ownerId: "35219013", ownerName: "Kyle Maxwell", prefsId: 2, pinEnv: "STAGING_PIN_KYLE" },
];

/** City centers only, jittered a few miles: the seed never carries a street
 *  address, a real business name or a real phone number. */
const SOCAL = [
  ["Los Angeles", 34.0522, -118.2437], ["Long Beach", 33.7701, -118.1937], ["Irvine", 33.6846, -117.8265],
  ["San Diego", 32.7157, -117.1611], ["Pasadena", 34.1478, -118.1445], ["Riverside", 33.9806, -117.3755],
  ["Santa Barbara", 34.4208, -119.6982], ["Torrance", 33.8358, -118.3406],
];
const NORCAL = [
  ["San Francisco", 37.7749, -122.4194], ["Oakland", 37.8044, -122.2712], ["Sacramento", 38.5816, -121.4944],
  ["San Jose", 37.3382, -121.8863], ["Santa Rosa", 38.4404, -122.7141], ["Berkeley", 37.8715, -122.273],
  ["Fresno", 36.7378, -119.7871], ["Chico", 39.7285, -121.8375],
];
const CHANNELS = ["specialty", "grocery", "coop", "clinic", "gym"];
const LIFECYCLES = ["active", "active", "dormant", "prospect"];
const READINESS = [null, "normal", "hot", "cold", "urgent"];
const HOURS = { mon: [["09:00", "19:00"]], tue: [["09:00", "19:00"]], wed: [["09:00", "19:00"]], thu: [["09:00", "19:00"]], fri: [["09:00", "19:00"]], sat: [["10:00", "17:00"]], sun: [] };

/** Seeded so a dry run and a real run describe the same rows. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const q = (v) => (v === null || v === undefined ? "null" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const pad = (n) => String(n).padStart(2, "0");

function seedAccounts() {
  const r = rng(20261008);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const rows = [];
  for (let i = 1; i <= 30; i++) {
    const rep = i <= 15 ? REPS[0] : REPS[1];
    const [city, lat0, lng0] = pick(i <= 15 ? SOCAL : NORCAL);
    const lifecycle = pick(LIFECYCLES);
    const active = lifecycle === "active";
    const daysAgo = Math.floor(r() * 300) + 10;
    const revenue = active ? Math.round(r() * 9000 + 500) : null;
    rows.push({
      id: `a_stg${pad(i)}`,
      name: `Staging Market ${pad(i)}`,
      channel: pick(CHANNELS),
      street: null,
      city,
      state: "CA",
      lat: Number((lat0 + (r() - 0.5) * 0.12).toFixed(6)),
      lng: Number((lng0 + (r() - 0.5) * 0.12).toFixed(6)),
      phone: `(310) 555-01${pad(i)}`, // 555-01xx is the reserved fictional range
      lifecycle,
      last_order_at: active ? new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10) : null,
      trailing_12m_revenue: revenue,
      lifetime_revenue: revenue === null ? null : revenue * 3,
      readiness: pick(READINESS),
      hubspot_owner_id: rep.ownerId,
      owner_name: rep.ownerName,
    });
  }
  return rows;
}

const HOME = { id: "a_home01", name: "Staging Home", city: "Los Angeles", lat: 34.0407, lng: -118.2468 };

function seedSql(pins) {
  const accounts = seedAccounts();
  const cols = [
    "id", "name", "channel", "street", "city", "state", "lat", "lng", "phone", "lifecycle",
    "last_order_at", "trailing_12m_revenue", "lifetime_revenue", "readiness", "hubspot_owner_id", "owner_name",
  ];
  const acctValues = accounts
    .map((a) => `(${cols.map((c) => q(a[c])).join(", ")}, ${q(JSON.stringify(HOURS))}::jsonb, 'synthetic', ${q(DATASET)})`)
    .join(",\n  ");
  const users = REPS.map((rep) => {
    const salt = randomBytes(16).toString("hex");
    const hash = pins ? createHash("sha256").update(`${salt}:${pins[rep.id]}`).digest("hex") : "dry-run";
    return `(${[rep.id, rep.name, rep.ownerId, rep.ownerName, salt, hash, rep.prefsId].map(q).join(", ")}, null)`;
  });
  const sql = `
insert into nb_synthetic_datasets (id, label, note)
values (${q(DATASET)}, 'Staging seed', 'Fake accounts for the staging database. Not real businesses, never real data.')
on conflict (id) do nothing;

insert into nb_ui_prefs (id) values (1), (2) on conflict (id) do nothing;

insert into nb_accounts (id, name, city, state, lat, lng, channel, lifecycle, origin, synthetic_dataset_id,
  timezone, hubspot_owner_id, owner_name, do_not_visit)
values (${[HOME.id, HOME.name, HOME.city, "CA", HOME.lat, HOME.lng, "unknown", "waypoint", "synthetic", DATASET, "America/Los_Angeles", REPS[0].ownerId, REPS[0].ownerName].map(q).join(", ")}, false)
on conflict (id) do nothing;

insert into nb_accounts (${cols.join(", ")}, business_hours, origin, synthetic_dataset_id)
values
  ${acctValues}
on conflict (id) do nothing;

insert into nb_users (id, name, hubspot_owner_id, owner_name, pin_salt, pin_hash, prefs_id, features)
values
  ${users.join(",\n  ")}
on conflict (id) do update set
  name = excluded.name, hubspot_owner_id = excluded.hubspot_owner_id, owner_name = excluded.owner_name,
  pin_salt = excluded.pin_salt, pin_hash = excluded.pin_hash, prefs_id = excluded.prefs_id,
  features = excluded.features, disabled_at = null;
`;
  return { sql, accounts };
}

/* ------------------------------------------------------------------------ */
/* Management API                                                            */
/* ------------------------------------------------------------------------ */

function accessToken() {
  if (process.env.STAGING_SUPABASE_ACCESS_TOKEN) return process.env.STAGING_SUPABASE_ACCESS_TOKEN.trim();
  const envFile = join(AGENCY, "nutribiotic", ".env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.trim().match(/^SUPABASE_ACCESS_TOKEN=(.*)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  }
  die(`No Supabase management token: set STAGING_SUPABASE_ACCESS_TOKEN or SUPABASE_ACCESS_TOKEN in ${envFile}.`);
}

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).message ?? text;
    } catch {
      /* plain-text error body */
    }
    throw new Error(`HTTP ${res.status}: ${String(detail).slice(0, 800)}`);
  }
  return text ? JSON.parse(text) : null;
}

const query = (token, sql) => api(token, "POST", `/projects/${REF}/database/query`, { query: sql });

/* ------------------------------------------------------------------------ */
/* Run                                                                       */
/* ------------------------------------------------------------------------ */

async function main() {
  const { list, findings } = loadMigrations();

  let pins = null;
  if (!DRY) {
    const pj = process.env.STAGING_PIN_JUAN ?? "";
    const pk = process.env.STAGING_PIN_KYLE ?? "";
    if (!pj || !pk) die("Set STAGING_PIN_JUAN and STAGING_PIN_KYLE (the staging sign-in PINs).");
    if (pj === pk) die("STAGING_PIN_JUAN and STAGING_PIN_KYLE must differ: a PIN resolves to exactly one rep.");
    pins = { juan: pj, kyle: pk };
  }
  const seed = seedSql(pins);

  if (DRY) {
    console.log(`Plan for staging project ${REF} (dry run, nothing contacted)`);
    console.log(`\nMigrations, in order (${list.length}):`);
    for (const m of list) console.log(`  ${m.name}`);
    console.log("\nData findings:");
    for (const f of findings) console.log(`  ${f}`);
    console.log(`  every other literal insert targets ${[...SAFE_INSERT_TABLES].join(", ")} only`);
    console.log("\nSeed:");
    console.log(`  nb_synthetic_datasets  1 row (${DATASET})`);
    console.log(`  nb_accounts            ${seed.accounts.length + 1} rows: ${seed.accounts.length} Staging Market accounts + 1 synthetic home waypoint`);
    for (const rep of REPS) {
      const n = seed.accounts.filter((a) => a.hubspot_owner_id === rep.ownerId).length;
      console.log(`                         ${n} owned by ${rep.id} (${rep.ownerId})`);
    }
    console.log(`  nb_users               ${REPS.length} rows (${REPS.map((r) => r.id).join(", ")}), PINs from STAGING_PIN_JUAN / STAGING_PIN_KYLE`);
    console.log(`  nb_ui_prefs            rows 1 and 2 ensured`);
    if (flag("--show-seed")) console.log(`\nSeed SQL (PIN hashes elided):\n${seed.sql}`);
    return;
  }

  const token = accessToken();
  const project = await api(token, "GET", `/projects/${REF}`);
  if (project?.id && project.id !== REF) die("The Management API answered for a different project. Stopping.");
  console.log(`Staging project: ${project?.name ?? REF} (${REF})`);

  await query(
    token,
    `create table if not exists staging_migrations (name text primary key, applied_at timestamptz not null default now());
     alter table staging_migrations enable row level security;`,
  );
  const done = new Set(((await query(token, "select name from staging_migrations")) ?? []).map((r) => r.name));

  let applied = 0;
  for (const m of list) {
    if (done.has(m.name)) continue;
    try {
      await query(token, `${m.sql}\n;\ninsert into staging_migrations (name) values (${q(m.name)});`);
    } catch (e) {
      die(`Stopped at ${m.name}: ${e instanceof Error ? e.message : e}\nNothing from that file was recorded; fix it and rerun to continue from here.`);
    }
    applied++;
    console.log(`applied ${m.name}`);
  }
  console.log(`${applied} migration(s) applied, ${list.length - applied} already on file.`);

  try {
    await query(token, seed.sql);
  } catch (e) {
    die(`Seed failed: ${e instanceof Error ? e.message : e}`);
  }
  const counts = await query(
    token,
    `select (select count(*) from nb_accounts where synthetic_dataset_id = ${q(DATASET)}) as accounts,
            (select count(*) from nb_users) as users,
            (select count(*) from nb_accounts where origin <> 'synthetic') as non_synthetic`,
  );
  const c = counts?.[0] ?? {};
  console.log(`Seeded: ${c.accounts} synthetic accounts, ${c.users} users. Non-synthetic accounts: ${c.non_synthetic}.`);
  if (Number(c.non_synthetic) > 0) console.log("Warning: this database holds rows the seed did not write. Staging should hold synthetic data only.");
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
