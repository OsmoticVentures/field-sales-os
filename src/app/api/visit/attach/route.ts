/**
 * Attaches a photo to a filed touchpoint, uploaded to Drive. Or, with
 * `note_key`, to a note still in the inbox (waiting.ts): uploaded now, so the
 * phone item clears, and filed onto the touchpoint when the note files.
 * Ported from portfolio/src/app/nutribiotic/api/visits/attach/route.ts.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { appendTouchpointAttachments, attachTouchpointPhoto, uploadVisitPhoto } from "../../../../lib/features/visit/dal";
import { addAttachment, getWaiting } from "../../../../lib/features/visit/waiting";
import { captureError } from "@/lib/core/errors";

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
  const noteKey = form.get("note_key");
  if ((typeof touchpointId !== "string" || !touchpointId) && (typeof noteKey !== "string" || !noteKey)) {
    return Response.json({ ok: false, error: "touchpoint_id or note_key is required." }, { status: 400 });
  }
  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return Response.json({ ok: false, error: "No photo." }, { status: 400 });
  }

  try {
    const bytes = await photo.arrayBuffer();
    const file = { bytes, mimeType: photo.type || "image/jpeg", filename: photo.name || "photo.jpg" };
    const { result, replayed } = await withIdempotency(`visit:attach:${key}`, async () => {
      if (typeof touchpointId === "string" && touchpointId) return attachTouchpointPhoto(touchpointId, file);
      const note = await getWaiting(noteKey as string);
      if (!note) throw new Error("That note is no longer in the inbox.");
      // Filed already: straight onto its touchpoint.
      if (note.status === "filed" && note.touchpoint_id) return attachTouchpointPhoto(note.touchpoint_id, file);
      const att = await uploadVisitPhoto(note.key, file);
      const kept = await addAttachment(note.key, att);
      // Filed while it uploaded: finish() may have run before the line was kept.
      const now = await getWaiting(note.key);
      if (now?.status === "filed" && now.touchpoint_id) return appendTouchpointAttachments(now.touchpoint_id, [att]);
      return { attachments: kept?.attachments ?? [att] };
    });
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    captureError(err, "/api/visit/attach");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Attach failed." }, { status: 500 });
  }
}
