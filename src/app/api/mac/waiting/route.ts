/**
 * The Mac files one note from the inbox (waiting.ts). note_reader.py claims
 * the row, reads the note on the Max plan against api/mac/extract-spec, and
 * posts the parse here with the row's key. The text and hints come from the
 * row, never the caller. HubSpot is tried once inline, then retried on its own
 * schedule by hubspot_sweep.py. The filing itself is waiting-file.ts.
 *
 * POST { key, mac_parsed } -> { ok, result: { status, touchpointId? } }
 */
import { macAuthorized } from "../../../../lib/core/mac-auth";
import { fileFromMacRead } from "../../../../lib/features/visit/waiting-file";
import { invalidatePriorityBook } from "../../../../lib/features/prospect/dal";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  if (!macAuthorized(req)) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const body = await req.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key : "";
  if (!key || body?.mac_parsed === undefined) {
    return Response.json({ ok: false, error: "key and mac_parsed are required." }, { status: 400 });
  }
  invalidatePriorityBook();
  try {
    const result = await fileFromMacRead(key, body.mac_parsed);
    return Response.json({ ok: true, result });
  } catch (err) {
    captureError(err, "/api/mac/waiting");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "That note did not file." }, { status: 500 });
  }
}
