/**
 * Attaches a photo to an already-filed touchpoint, uploaded to Drive.
 * Ported from portfolio/src/app/nutribiotic/api/visits/attach/route.ts.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { attachTouchpointPhoto } from "../../../../lib/features/visit/dal";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ ok: false, error: "Expected multipart/form-data." }, { status: 400 });
  }
  const key = idempotencyKey(req, form);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key is required." }, { status: 400 });

  const touchpointId = form.get("touchpoint_id");
  if (typeof touchpointId !== "string" || !touchpointId) {
    return Response.json({ ok: false, error: "touchpoint_id is required." }, { status: 400 });
  }
  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return Response.json({ ok: false, error: "No photo." }, { status: 400 });
  }

  try {
    const bytes = await photo.arrayBuffer();
    const { result, replayed } = await withIdempotency(`visit:attach:${key}`, () =>
      attachTouchpointPhoto(touchpointId, {
        bytes,
        mimeType: photo.type || "image/jpeg",
        filename: photo.name || "photo.jpg",
      }),
    );
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Attach failed." }, { status: 500 });
  }
}
