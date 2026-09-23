/**
 * The two reads a rep forms at the door, applied once the note has landed on
 * an account: Potential (A-E size) and Readiness (how close to buying).
 * Local only, same as the source app's setPotentialJuan/setReadiness.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import {
  READINESS_VALUES,
  VISIT_GRADES,
  setAccountPotentialJuan,
  setAccountReadiness,
  type Readiness,
  type VisitGrade,
} from "../../../../lib/features/visit/dal";

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
  if (grade && !VISIT_GRADES.includes(grade)) return Response.json({ ok: false, error: "Bad grade." }, { status: 400 });
  if (readiness && !READINESS_VALUES.includes(readiness)) {
    return Response.json({ ok: false, error: "Bad readiness." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`visit:account-read:${key}`, async () => {
      if (grade) await setAccountPotentialJuan(accountId, grade);
      if (readiness) await setAccountReadiness(accountId, readiness);
      return { grade: grade ?? null, readiness: readiness ?? null };
    });
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not save that." }, { status: 500 });
  }
}
