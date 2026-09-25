/**
 * Suggested returns for the Route screen. GET builds the week's list from
 * pending "come back" directives in Juan's book; POST marks one handled
 * once he acts on it (added to a day, or queued on SDR).
 */
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";
import { isConfigured, listPendingReturnDirectives, resolveDirective } from "../../../../lib/features/route/dal";
import { buildReturnSuggestions } from "../../../../lib/features/route/return-suggestions";
import { getPriorityBook } from "../../../../lib/features/prospect/dal";

export const runtime = "nodejs";

export async function GET() {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  if (!isConfigured()) return Response.json({ ok: true, suggestions: [] });
  try {
    const [book, directives] = await Promise.all([getPriorityBook(), listPendingReturnDirectives()]);
    const bookIds = new Set(book.ranked.map((r) => r.account.id));
    return Response.json({ ok: true, suggestions: buildReturnSuggestions(bookIds, directives) });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't load suggestions." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { directiveId?: string; resolution?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  if (typeof body.directiveId !== "string" || typeof body.resolution !== "string") {
    return Response.json({ ok: false, error: "directiveId and resolution are required." }, { status: 400 });
  }

  try {
    const { replayed } = await withIdempotency(`route:return:${key}`, async () => {
      await resolveDirective(body.directiveId!, body.resolution!);
      return true;
    });
    return Response.json({ ok: true, replayed });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't save that." }, { status: 500 });
  }
}
