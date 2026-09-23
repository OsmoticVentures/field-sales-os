/**
 * Road time over the real network for an ordered set of points: legs for the
 * schedule/list, a full matrix for the smart-insert and optimize buttons.
 * Read-only (no Idempotency-Key), calls OSRM server-side so the 1.35 factor
 * and the fallback rule live in one place.
 */
import { routeDriveLegs, routeDriveMatrix } from "../../../../lib/features/route/drive";
import { hasAccess } from "../../../../lib/core/devices";

export const runtime = "nodejs";

type Point = { lat: number; lng: number };

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }

  let body: { points?: Point[]; mode?: "legs" | "matrix" };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  const points = Array.isArray(body.points) ? body.points : [];
  if (points.length < 2) return Response.json({ ok: true, legs: null, matrix: null });

  if (body.mode === "matrix") {
    const matrix = await routeDriveMatrix(points);
    return Response.json({ ok: true, matrix });
  }
  const legs = await routeDriveLegs(points);
  return Response.json({ ok: true, legs });
}
