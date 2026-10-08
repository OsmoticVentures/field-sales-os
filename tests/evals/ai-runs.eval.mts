// Offline error analysis of ClientOS's AI steps: read the recent real runs
// from nb_ai_runs, apply each task's pass/fail checks (./checks.mts), print
// a failure table. Never calls a model, so it costs no API spend.
//
//   node --experimental-strip-types tests/evals/ai-runs.eval.mts            # last 7 days
//   node --experimental-strip-types tests/evals/ai-runs.eval.mts --days 1 --task touchpoint_extract
//   node --experimental-strip-types tests/evals/ai-runs.eval.mts --file runs.json   # an exported array of rows
//   ... --show 20      # print up to 20 failing rows with their reasons
//
// Reads NB_SUPABASE_URL and NB_SUPABASE_SERVICE_ROLE_KEY from the environment
// (the same pair the app uses; never printed). One read of at most 500 rows,
// about 1-4 MB: run it by hand, never on a loop (root P9).
import { readFileSync } from "node:fs";
import { evaluate, type RunRow } from "./checks.mts";

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? null) : null;
};
const days = Number(arg("days") ?? 7);
const task = arg("task");
const file = arg("file");
const show = Number(arg("show") ?? 10);
const LIMIT = 500;

async function load(): Promise<RunRow[]> {
  if (file) return JSON.parse(readFileSync(file, "utf8")) as RunRow[];
  const url = process.env.NB_SUPABASE_URL;
  const key = process.env.NB_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Set NB_SUPABASE_URL and NB_SUPABASE_SERVICE_ROLE_KEY, or pass --file runs.json.");
    process.exit(2);
  }
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const q = new URLSearchParams({
    select: "id,created_at,task,model,ok,validation,attempts,fallback_used,latency_ms,stop_reason,input_excerpt,output_excerpt,error",
    created_at: `gte.${since}`,
    order: "created_at.desc",
    limit: String(LIMIT),
  });
  if (task) q.set("task", `eq.${task}`);
  const res = await fetch(`${url}/rest/v1/nb_ai_runs?${q}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!res.ok) {
    console.error(`nb_ai_runs -> HTTP ${res.status}`);
    process.exit(2);
  }
  return (await res.json()) as RunRow[];
}

const rows = (await load()).filter((r) => !task || r.task === task);
const { failures, counts } = evaluate(rows);

console.log(`${rows.length} runs${file ? ` from ${file}` : `, last ${days} day(s)`}${task ? `, task ${task}` : ""}\n`);
const table: Record<string, string | number>[] = [];
for (const [t, c] of [...counts.entries()].sort()) {
  if (!c.failed.size) table.push({ task: t, runs: c.runs, check: "(all pass)", failed: 0, rate: "0%" });
  for (const [check, n] of [...c.failed.entries()].sort((a, b) => b[1] - a[1])) {
    table.push({ task: t, runs: c.runs, check, failed: n, rate: `${Math.round((100 * n) / c.runs)}%` });
  }
}
console.table(table);

if (failures.length && show > 0) {
  console.log(`\nFirst ${Math.min(show, failures.length)} failing rows:`);
  for (const f of failures.slice(0, show)) console.log(`  #${f.id ?? "?"} ${f.at?.slice(0, 16) ?? ""} ${f.task} / ${f.check}: ${f.reason}`);
}
process.exitCode = 0;
