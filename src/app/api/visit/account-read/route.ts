/**
 * The reads a rep forms at the door, applied once the note has landed on an
 * account: Potential (A-E size), Readiness (how close to buying) and the
 * counts (supplement shelves, staff selling them, stores one owner runs).
 * Local only, same as the source app's setPotentialJuan/setReadiness.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import {
  DOOR_COUNT_FIELDS,
  READINESS_VALUES,
  VISIT_GRADES,
  setAccountPotentialJuan,
  setAccountCounts,
  setAccountReadiness,
  type DoorCountField,
  type Readiness,
  type VisitGrade,
} from "../../../../lib/features/visit/dal";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  const body = await req.json().catch(() => null);
  const accountId = body?.account_id as string | undefined;
  const grade = body?.grade as VisitGrade | undefined;
  const readiness = body?.readiness as Readiness | undefined;
  if (!accountId) return Response.json({ ok: false, error: "account_id is required." }, { status: 400 });
  const counts: Partial<Record<DoorCountField, number>> = {};
  for (const f of DOOR_COUNT_FIELDS) {
    const v = body?.counts?.[f];
    if (v === undefined || v === null) continue;
    if (!Number.isInteger(v) || v < 0) return Response.json({ ok: false, error: "Counts are whole numbers." }, { status: 400 });
    counts[f] = v;
  }
  if (grade && !VISIT_GRADES.includes(grade)) return Response.json({ ok: false, error: "Bad grade." }, { status: 400 });
  if (readiness && !READINESS_VALUES.includes(readiness)) {
    return Response.json({ ok: false, error: "Bad readiness." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`visit:account-read:${key}`, async () => {
      if (grade) await setAccountPotentialJuan(accountId, grade);
      if (readiness) await setAccountReadiness(accountId, readiness);
      await setAccountCounts(accountId, counts);
      return { grade: grade ?? null, readiness: readiness ?? null, counts };
    });
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    captureError(err, "/api/visit/account-read");
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not save that." }, { status: 500 });
  }
}
