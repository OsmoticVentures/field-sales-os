/**
 * Accept or dismiss one proposal Find Contacts surfaced. A proposal is not
 * a row anywhere; the client sends back the exact object the run returned
 * and this route re-reads the live account/contact before writing, so
 * accepting an id after the underlying row changed underneath it fails
 * loudly rather than clobbering something else (dal.ts's applyProposal).
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { applyProposal, dismissProposal } from "../../../../lib/features/enrich/dal";
import type { Proposal } from "../../../../lib/features/enrich/types";

export const runtime = "nodejs";
export const maxDuration = 20;

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  const body = await req.json().catch(() => null);
  const proposal = body?.proposal as Proposal | undefined;
  const action = body?.action as "accept" | "dismiss" | undefined;
  if (!proposal?.id || !proposal.account_id || !action) {
    return Response.json({ ok: false, error: "Missing proposal or action." }, { status: 400 });
  }

  try {
    const { result, replayed } = await withIdempotency(`enrich:proposal:${key}`, async () => {
      if (action === "dismiss") {
        await dismissProposal(proposal.account_id, proposal.id);
        return { ok: true as const };
      }
      return applyProposal(proposal);
    });
    return Response.json({ ok: true, result, replayed });
  } catch (err) {
    return Response.json({ ok: false, error: err instanceof Error ? err.message : "Could not apply that." }, { status: 500 });
  }
}
