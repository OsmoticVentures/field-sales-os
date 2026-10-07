/**
 * Saves one of the four tier fields typed into a Clients row. A blank clears
 * it. The letter itself is recomputed by score.py, not here.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { METRIC_FIELDS, setMetric, type MetricField } from "../../../../lib/features/clients/dal";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  let body: { accountId?: string; field?: string; value?: number | string | null };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  const field = body.field as MetricField;
  if (!body.accountId || !METRIC_FIELDS.includes(field)) return Response.json({ ok: false, error: "Unknown field." }, { status: 400 });
  const raw = body.value;
  const value = raw === null || raw === "" || raw === undefined ? null : Number(raw);
  if (value !== null && (!Number.isFinite(value) || value < 0)) return Response.json({ ok: false, error: "Enter a number, zero or more." }, { status: 400 });
  if (field === "supp_body_pct" && value !== null && value > 100) return Response.json({ ok: false, error: "A share is 0 to 100." }, { status: 400 });
  if (field === "employee_count" && value !== null && !Number.isInteger(value)) return Response.json({ ok: false, error: "Whole employees only." }, { status: 400 });
  try {
    await setMetric(body.accountId, field, value);
    return Response.json({ ok: true });
  } catch (err) {
    console.error("clients/metric", body.accountId, field, err);
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not save." }, { status: 500 });
  }
}
