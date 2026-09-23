/**
 * The backlog behind /nb/visit/review: every touchpoint still parked as
 * needs_account or needs_next_step, oldest first. Read-only, no idempotency
 * key. Ported from portfolio/src/app/nutribiotic/api/visit-queues/route.ts,
 * trimmed to the two queues this port carries (see the port's handback for
 * what stayed behind: calendar proposals and unfiled-activity retries).
 */
import { hasAccess } from "../../../../lib/core/devices";
import { getAccountNames, listPendingAccountMatches, listPendingNextSteps } from "../../../../lib/features/visit/dal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  try {
    const [pending, pendingNextSteps] = await Promise.all([listPendingAccountMatches(), listPendingNextSteps()]);
    const nextStepAccountIds = pendingNextSteps.map((tp) => tp.account_id).filter((id): id is string => Boolean(id));
    const accountNames = await getAccountNames([...new Set(nextStepAccountIds)]).catch(() => ({}) as Record<string, string>);

    return Response.json(
      { ok: true, pending, pendingNextSteps, accountNames },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ ok: false }, { status: 200, headers: { "cache-control": "no-store" } });
  }
}
