/**
 * Clock in/out from the browser. Same filing path as the CLI's `hours`
 * subcommand. Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/api/expenses/hours/route.ts), with an
 * idempotency guard added per PORTING.md: this creates a row, so a repeat
 * POST with the same key must not create a second one.
 */
import { fileHours } from "../../../../lib/shared/expenses";
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const key = idempotencyKey(req);
  if (!key) {
    return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const date = body?.date as string | undefined;
  const clockIn = body?.clock_in as string | undefined;
  const clockOut = body?.clock_out as string | undefined;
  const breakMin = Number(body?.break_min ?? 0);
  const notes = (body?.notes as string | undefined)?.trim() ?? "";

  if (!date || !clockIn || !clockOut) {
    return Response.json({ ok: false, error: "date, clock_in and clock_out are required." }, { status: 400 });
  }
  if (!Number.isFinite(breakMin) || breakMin < 0) {
    return Response.json({ ok: false, error: "break_min must be a non-negative number." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`hours:${key}`, () =>
      fileHours({ date, clockIn, clockOut, breakMin, notes }),
    );
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Filing failed." }, { status: 500 });
  }
}
