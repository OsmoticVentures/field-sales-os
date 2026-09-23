/**
 * File one drive: start + end odometer photos and readings together, same
 * shape as the CLI's `trip` subcommand. Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/api/expenses/trip/route.ts), with an
 * idempotency guard added per PORTING.md.
 */
import { fileTrip } from "../../../../lib/shared/expenses";
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ ok: false, error: "Expected multipart/form-data." }, { status: 400 });
  }

  const key = idempotencyKey(req, form);
  if (!key) {
    return Response.json({ ok: false, error: "Idempotency-Key is required." }, { status: 400 });
  }

  const startPhoto = form.get("start_photo");
  const endPhoto = form.get("end_photo");
  if (!(startPhoto instanceof File) || startPhoto.size === 0) {
    return Response.json({ ok: false, error: "No start odometer photo." }, { status: 400 });
  }
  if (!(endPhoto instanceof File) || endPhoto.size === 0) {
    return Response.json({ ok: false, error: "No end odometer photo." }, { status: 400 });
  }
  const date = form.get("date") as string | null;
  const endDate = (form.get("end_date") as string | null) || undefined;
  const purpose = ((form.get("purpose") as string | null) ?? "").trim();
  const startOdo = ((form.get("start_odo") as string | null) ?? "").trim();
  const endOdo = ((form.get("end_odo") as string | null) ?? "").trim();

  if (!date || !startOdo || !endOdo) {
    return Response.json({ ok: false, error: "date, start_odo and end_odo are required." }, { status: 400 });
  }

  try {
    const [startBytes, endBytes] = await Promise.all([startPhoto.arrayBuffer(), endPhoto.arrayBuffer()]);
    const { result, replayed } = await withIdempotency(`trip:${key}`, () =>
      fileTrip({
        date, endDate, purpose, startOdo, endOdo,
        startPhoto: { bytes: startBytes, mimeType: startPhoto.type || "image/jpeg", filename: startPhoto.name || "start.jpg" },
        endPhoto: { bytes: endBytes, mimeType: endPhoto.type || "image/jpeg", filename: endPhoto.name || "end.jpg" },
      }),
    );
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Filing failed." }, { status: 500 });
  }
}
