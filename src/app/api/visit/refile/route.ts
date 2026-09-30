/**
 * Files an already-logged activity to HubSpot again, after the first try
 * failed. The engagement writer checks for its own earlier note first, so a
 * retry never makes a second one.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { autoFileEngagement } from "../../../../lib/features/visit/touchpoint";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  const activityId = Number(body?.activityId);
  if (!Number.isInteger(activityId) || activityId <= 0) {
    return Response.json({ ok: false, error: "activityId is required." }, { status: 400 });
  }
  const filed = await autoFileEngagement(activityId);
  return Response.json({ ok: true, result: filed });
}
