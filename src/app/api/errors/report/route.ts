/**
 * A phone reports an error it caught (lib/core/client-errors.ts). Signed-in
 * only, so the open internet cannot write rows; size-clipped and fingerprinted
 * server side (lib/core/errors.ts), which also caps writes per instance.
 * No idempotency key: a repeat is just one more hit on the same row.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { capture } from "../../../../lib/core/errors";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await hasAccess())) return new Response(null, { status: 204 });
  let body: { message?: unknown; stack?: unknown; route?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(null, { status: 204 });
  }
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  const message = str(body.message, 500);
  if (message) capture({ kind: "client", message, stack: str(body.stack, 4000), route: str(body.route, 200) });
  return new Response(null, { status: 204 });
}
