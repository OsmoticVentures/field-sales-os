/**
 * The Mac's door onto the one HubSpot engagement filer, runEngagement
 * (hubspot-engagement.ts). Every Mac script that files a Note, Call, Meeting
 * or Email (clients.py, file_outreach.py, the Outlook sent and received pulls)
 * comes through here via bridges/nutribiotic/lib/clientos.py's
 * file_engagement(), so the phone and the Mac file through the same code.
 *
 * POST { activity_id, write, feature?, email? }. Dry unless write is true, and
 * a write still needs that feature's own flag (writeEnabled): a write asked
 * for while the flag is off answers 409 with nothing written, never a bypass.
 * Blocked answers 409 and a kind that never files (a field note) 422, each
 * with its own sentence.
 */
import { macAuthorized } from "../../../../lib/core/mac-auth";
import { captureError } from "@/lib/core/errors";
import { Blocked, NeverFiledKindError, runEngagement, type EmailOverride } from "../../../../lib/features/visit/hubspot-engagement";
import { ScopeError, writeEnabled, type HubspotFeature } from "../../../../lib/features/visit/hubspot";

export const runtime = "nodejs";
export const maxDuration = 60;

const FEATURES: HubspotFeature[] = ["visit", "outbound"];

function emailOverride(raw: unknown): EmailOverride | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const out = { subject: str(r.subject), to: str(r.to), from: str(r.from) };
  return out.subject || out.to || out.from ? out : undefined;
}

export async function POST(req: Request) {
  if (!macAuthorized(req)) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });

  const body = await req.json().catch(() => null);
  const activityId = Number(body?.activity_id);
  if (!Number.isInteger(activityId) || activityId <= 0) {
    return Response.json({ ok: false, error: "activity_id is required." }, { status: 400 });
  }
  const feature = (body?.feature ?? "visit") as HubspotFeature;
  if (!FEATURES.includes(feature)) {
    return Response.json({ ok: false, error: `feature must be one of ${FEATURES.join(", ")}.` }, { status: 400 });
  }
  const write = body?.write === true;
  const enabled = writeEnabled(feature);
  if (write && !enabled) {
    return Response.json(
      { ok: false, error: `HubSpot filing for ${feature} is off on this deployment. Nothing written.` },
      { status: 409 },
    );
  }

  try {
    const result = await runEngagement(activityId, { write, feature, email: emailOverride(body?.email) });
    return Response.json({ ok: true, result: { ...result, writeEnabled: enabled } });
  } catch (err) {
    if (err instanceof NeverFiledKindError) return Response.json({ ok: false, error: err.message }, { status: 422 });
    if (err instanceof Blocked || err instanceof ScopeError) return Response.json({ ok: false, error: err.message }, { status: 409 });
    captureError(err, "/api/mac/hubspot");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "HubSpot filing failed." }, { status: 500 });
  }
}
