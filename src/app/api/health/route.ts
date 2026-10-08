import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { stage } from "../../../lib/core/stage";

// Route handler, not a server action. Every write in this app follows this
// pattern from the start (PORTING.md, m7): server actions can't run
// cleanly in the static/native context the Capacitor shell needs (m12+).
// `stage` says which deployment answered (lib/core/stage.ts), so a check
// against the staging alias can tell it is not production.
//
// `?db=1` adds three timed one-row reads from the database, run from this
// function's own region, and `db_id`, the first 8 hex of sha256 of the
// database URL, so a check can tell which project answered without the
// project ref being shown (PERF.md, region move).
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const body: Record<string, unknown> = { ok: true, service: "field-sales-os", stage: stage() };
  if (new URL(req.url).searchParams.get("db") === "1") body.db = await timedReads();
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}

async function timedReads() {
  const url = process.env.NB_SUPABASE_URL ?? "";
  const key = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return { error: "not configured" };
  const ms: number[] = [];
  let status = 0;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const r = await fetch(`${url}/rest/v1/nb_config?select=key&limit=1`, {
      headers: { apikey: key, authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    await r.arrayBuffer();
    status = r.status;
    ms.push(Math.round(performance.now() - t0));
  }
  return {
    db_id: createHash("sha256").update(url.replace(/\/+$/, "")).digest("hex").slice(0, 8),
    status,
    ms,
  };
}
