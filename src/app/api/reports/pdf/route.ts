/**
 * A report link that is still alive when Juan clicks it. Ported from the
 * NutriBiotic OS (portfolio/src/app/nutribiotic/api/report/route.ts): the
 * page links here, a stable path that never expires, and the signature is
 * minted at the moment of the click and redirected to immediately. A read,
 * not a write, no idempotency key needed.
 *
 * The bucket stays private. This route sits behind the same device gate as
 * every other screen, and the object name is checked against a strict
 * pattern before it reaches Supabase: a plain filename, no path separators,
 * .pdf only.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { signReportObject } from "../../../../lib/features/reports/dal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.pdf$/;

export async function GET(req: Request) {
  if (!(await hasAccess())) {
    return new Response("Not available.", { status: 403, headers: { "cache-control": "no-store" } });
  }
  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!NAME.test(name) || name.includes("..")) {
    return new Response("That report name is not valid.", { status: 400, headers: { "cache-control": "no-store" } });
  }
  const signed = await signReportObject(name);
  if (!signed) {
    return new Response("That report is not available.", { status: 404, headers: { "cache-control": "no-store" } });
  }
  return Response.redirect(signed, 302);
}
