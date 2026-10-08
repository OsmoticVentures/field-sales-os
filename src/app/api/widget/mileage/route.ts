/**
 * One odometer photo, start or end, from the widget's camera-gated route.
 * Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/api/widget/mileage/route.ts). Uploads into
 * the same Drive/Sheets tree the Expenses port already files mileage into
 * (lib/shared/expenses.ts), reads a best-effort odometer value off the
 * photo, and once both sides of a day exist, files the trip row
 * automatically.
 *
 * Auth is widened on purpose, same as the widget read endpoint: a photo of
 * Juan's own odometer, nowhere near a customer record or HubSpot, is a low
 * enough stakes write for the widget's own bearer token.
 */
import { z } from "zod";
import { getLastRouteOdo, setLastRouteOdo, setRouteMileageDay } from "../../../../lib/features/route/dal";
import type { RouteMileageSide } from "../../../../lib/features/route/dal";
import { fileTripFromLinks, uploadMileagePhoto } from "../../../../lib/shared/expenses";
import { hasAccess } from "../../../../lib/core/devices";
import { hasWidgetToken } from "../../../../lib/features/route/widget-auth";
import { captureError } from "@/lib/core/errors";
import { ai, aiConfigured, isAiCap } from "../../../../lib/core/ai/client";

export const runtime = "nodejs";
export const maxDuration = 45;

const ReadSchema = z.object({
  reading: z.string().nullable().describe("The total odometer number, digits only. Null if not clearly legible, never a guess."),
});

/** The reading, or null. `capped` carries the day's AI limit sentence when
 *  that is why it was not read: the photo still files, without a reading. */
async function readOdometer(bytes: ArrayBuffer, mimeType: string): Promise<{ reading: string | null; capped?: string }> {
  if (!aiConfigured()) return { reading: null };
  try {
    const base64 = Buffer.from(bytes).toString("base64");
    const { data } = await ai({
      task: "mileage_odometer",
      system:
        "Read the total odometer number from this car dashboard photo. An unreadable or ambiguous digit means the " +
        "reading is null, never a plausible guess, this feeds a mileage reimbursement.",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType as "image/jpeg", data: base64 } },
            { type: "text", text: "Read the odometer." },
          ],
        },
      ],
      schema: ReadSchema,
    });
    return { reading: data.reading ?? null };
  } catch (err) {
    return isAiCap(err) ? { reading: null, capped: err.message } : { reading: null };
  }
}

async function recordSide(day: string, kind: "start" | "end", side: RouteMileageSide, capped?: string) {
  if (side.odo) await setLastRouteOdo(side.odo);

  const today = (await setRouteMileageDay(day, { [kind]: side }))[day] ?? {};

  if (!today.start || !today.end) {
    return Response.json({
      ok: true,
      filed: false,
      odo: side.odo,
      photoLink: side.photoLink,
      ...(capped ? { error: `Photo saved, odometer not read. ${capped} Enter it by hand on Expenses.` } : {}),
    });
  }

  if (today.start.odo && today.end.odo) {
    try {
      const filed = await fileTripFromLinks({
        date: day,
        startOdo: today.start.odo,
        endOdo: today.end.odo,
        startLink: today.start.photoLink,
        endLink: today.end.photoLink,
      });
      // Sides stay on record so the day reads as ended and the widget never
      // asks for the odometer a second time.
      await setRouteMileageDay(day, { filedSheetLink: filed.sheetLink, fileError: undefined });
      return Response.json({ ok: true, filed: true, sheetLink: filed.sheetLink, miles: filed.miles, odo: side.odo });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Filing failed.";
      await setRouteMileageDay(day, { fileError: message });
      return Response.json({ ok: true, filed: false, odo: side.odo, error: `Both sides saved. Filing the trip failed.` });
    }
  }

  await setRouteMileageDay(day, { fileError: "One side has no odometer reading." });
  return Response.json({
    ok: true,
    filed: false,
    odo: side.odo,
    error: capped
      ? `Both sides saved, odometer not read. ${capped} Enter it by hand on Expenses.`
      : "Both sides saved. One has no odometer reading, enter it by hand on Expenses.",
  });
}

export async function POST(req: Request) {
  if (!(await hasWidgetToken(req)) && !(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ ok: false, error: "Expected multipart/form-data." }, { status: 400 });
  }

  const kind = form.get("kind");
  const day = form.get("day");
  if (kind !== "start" && kind !== "end") {
    return Response.json({ ok: false, error: "kind must be start or end." }, { status: 400 });
  }
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return Response.json({ ok: false, error: "day must be YYYY-MM-DD." }, { status: 400 });
  }

  if (form.get("bypass") === "1") {
    try {
      const odo = kind === "start" ? ((await getLastRouteOdo())?.value ?? null) : null;
      return await recordSide(day, kind, { odo, driveFileId: "", photoLink: "", capturedAt: new Date().toISOString(), manual: true });
    } catch (e) {
      captureError(e, "/api/widget/mileage");
      return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't file that." }, { status: 500 });
    }
  }

  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    return Response.json({ ok: false, error: "No photo." }, { status: 400 });
  }

  try {
    const bytes = await photo.arrayBuffer();
    // Sniff the bytes: a widget can label a JPEG as anything, and a wrong
    // media type makes the odometer read fail silently.
    const head = new Uint8Array(bytes.slice(0, 4));
    const mimeType =
      head[0] === 0xff && head[1] === 0xd8 ? "image/jpeg" : head[0] === 0x89 && head[1] === 0x50 ? "image/png" : photo.type || "image/jpeg";
    const [read, uploaded] = await Promise.all([
      readOdometer(bytes, mimeType),
      uploadMileagePhoto(day, kind, { bytes, mimeType, filename: photo.name || `${kind}.jpg` }),
    ]);
    return await recordSide(
      day,
      kind,
      { odo: read.reading, driveFileId: uploaded.driveFileId, photoLink: uploaded.photoLink, capturedAt: new Date().toISOString() },
      read.capped,
    );
  } catch (e) {
    captureError(e, "/api/widget/mileage");
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Upload failed." }, { status: 500 });
  }
}
