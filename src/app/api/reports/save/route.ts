/**
 * Save Juan's edits to a day's report: HQ notes, the mileage override, each
 * stop's call-only/message-only/hidden classification, and stop order.
 * Ported from report-actions.ts's actionSaveReportEdits, as a route handler
 * with an idempotency guard per PORTING.md, since this app runs no Server
 * Actions. See lib/features/reports/dal.ts for what stayed on the old app
 * (route start/end override, marking a stop as a field note) and why.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { saveReportDraftPayload, type ReportEdits } from "../../../../lib/features/reports/dal";

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) {
    return Response.json({ ok: false, error: "Idempotency-Key is required." }, { status: 400 });
  }
  let date: string;
  let edits: ReportEdits;
  try {
    const body = (await req.json()) as { date?: string; edits?: ReportEdits };
    date = body.date ?? "";
    edits = body.edits ?? { hqNotes: [], miles: null, stops: {} };
  } catch {
    return Response.json({ ok: false, error: "Expected a JSON body." }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ ok: false, error: "A valid date is required." }, { status: 400 });
  }
  try {
    const { replayed } = await withIdempotency(`reports-save:${key}`, () => saveReportDraftPayload(date, edits));
    return Response.json({ ok: true, replayed });
  } catch {
    return Response.json({ ok: false, error: "Could not save your edits." }, { status: 500 });
  }
}
