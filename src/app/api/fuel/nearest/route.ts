/**
 * The three cheapest priced stations among the closest to the rep. Read-only:
 * nothing is written, so no Idempotency-Key (same carve-out as api/fuel/find).
 */
import { headers } from "next/headers";
import { hasAccess } from "../../../../lib/core/devices";
import { nearestCheapest } from "../../../../lib/features/fuel/nearest";

export const runtime = "nodejs";
export const maxDuration = 60;

const WINDOW_MS = 10 * 60 * 1000;
const BUDGET = 30;
const hits = new Map<string, number[]>();
function overBudget(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > BUDGET;
}

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (overBudget(ip)) return Response.json({ ok: false, error: "Too many searches in a row. Try again in a few minutes." });

  let body: { origin?: { lat: number; lng: number } };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "That request didn't parse." }, { status: 400 });
  }
  const origin = body.origin;
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) {
    return Response.json({ ok: false, error: "No location yet." });
  }
  let best;
  try {
    best = await nearestCheapest(origin);
  } catch {
    return Response.json({ ok: false, error: "Couldn't read gas prices right now. Try again." });
  }
  if (!best) return Response.json({ ok: false, error: "Couldn't measure distances right now. Try again." });
  if (best.length === 0) return Response.json({ ok: false, error: "No stations with a posted price near you." });
  return Response.json({ ok: true, best });
}
