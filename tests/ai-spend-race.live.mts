// The spend cap's race safety, against the real database: 50 reservations
// fired at once at nb_ai_spend_reserve, each $0.30 against a $5 cap, on a
// test day (2000-01-01) that never touches today's counter and never files an
// alert. Exactly 16 may pass (16 x 0.30 = 4.80; a 17th would be 5.10). Then
// settle, check the totals, and delete the test row.
//
// Not part of `pnpm test` (it needs the service key). Run by hand:
//   set -a; . ../../nutribiotic/.env; set +a
//   node --experimental-strip-types tests/ai-spend-race.live.mts
const URL_ = process.env.NB_SUPABASE_URL ?? "";
const KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!URL_ || !KEY) {
  console.error("NB_SUPABASE_URL and NB_SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(2);
}
const DAY = "2000-01-01";
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

async function rpc(name: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${URL_}/rest/v1/rpc/${name}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
async function row(): Promise<{ spent_usd: number; reserved_usd: number; calls: number; blocked: number; alerted_at: string | null } | undefined> {
  const res = await fetch(`${URL_}/rest/v1/nb_ai_spend_days?day=eq.${DAY}&select=spent_usd,reserved_usd,calls,blocked,alerted_at`, { headers });
  return ((await res.json()) as never[])[0];
}
async function cleanup() {
  await fetch(`${URL_}/rest/v1/nb_ai_spend_days?day=eq.${DAY}`, { method: "DELETE", headers });
}

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};

await cleanup();
try {
  const results = (await Promise.all(
    Array.from({ length: 50 }, () => rpc("nb_ai_spend_reserve", { p_usd: 0.3, p_cap: 5, p_day: DAY })),
  )) as { ok: boolean }[];
  const passed = results.filter((r) => r.ok).length;
  t("exactly 16 of 50 concurrent $0.30 holds pass a $5 cap", passed === 16, passed);
  let r = await row();
  t("held total is 4.80, never over the cap", Number(r?.reserved_usd) === 4.8, r);
  t("34 refusals counted", r?.blocked === 34, r);
  const alerts = (await (await fetch(`${URL_}/rest/v1/nb_app_errors?fingerprint=eq.aicap-${DAY}&select=fingerprint`, { headers })).json()) as unknown[];
  t("the day is marked alerted once, but a test day files no alert row", Boolean(r?.alerted_at) && alerts.length === 0, alerts);

  // Settle all 16 at $0.10 real cost each: 1.60 spent, nothing held.
  await Promise.all(Array.from({ length: 16 }, () => rpc("nb_ai_spend_settle", { p_day: DAY, p_reserved: 0.3, p_actual: 0.1 })));
  r = await row();
  t("settled: spent 1.60, held 0, 16 calls", Number(r?.spent_usd) === 1.6 && Number(r?.reserved_usd) === 0 && r?.calls === 16, r);

  // Room again: 3.40 left, so 11 more $0.30 holds pass (3.30) and the 12th does not.
  const again = (await Promise.all(
    Array.from({ length: 20 }, () => rpc("nb_ai_spend_reserve", { p_usd: 0.3, p_cap: 5, p_day: DAY })),
  )) as { ok: boolean }[];
  t("after settling, 11 more pass", again.filter((x) => x.ok).length === 11, again.filter((x) => x.ok).length);
} finally {
  await cleanup();
}
t("test row removed", (await row()) === undefined);

if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
console.log("ai spend race (live): all passed");
