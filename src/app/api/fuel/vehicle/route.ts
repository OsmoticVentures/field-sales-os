/** The signed-in rep's car and saved places, for the Fuel screen. */
import { hasAccess } from "../../../../lib/core/devices";
import { myVehicle } from "../../../../lib/features/fuel/vehicle";

export async function GET() {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  return Response.json({ ok: true, ...(await myVehicle()) }, { headers: { "cache-control": "no-store" } });
}
