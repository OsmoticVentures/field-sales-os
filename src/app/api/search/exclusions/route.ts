/**
 * The shared shortlist of past exclusions for the Search screen: chains and
 * categories Juan has excluded before, offered back as one-tap chips on every
 * device. GET reads both lists; POST remembers what was just excluded.
 * An upsert on (kind, lowercase value), so a replay changes nothing and it
 * takes no idempotency key.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { listExclusions, rememberExclusions } from "../../../../lib/features/search/dal";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  try {
    const [chains, categories] = await Promise.all([listExclusions("chain"), listExclusions("category")]);
    return Response.json({ ok: true, chains, categories });
  } catch (caught) {
    captureError(caught, "/api/search/exclusions");
    return Response.json({ ok: false, error: "Could not read past exclusions." }, { status: 502 });
  }
}

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  let body: { chains?: unknown; categories?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected a JSON body." }, { status: 400 });
  }
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 60) : []);
  try {
    await rememberExclusions("chain", strs(body.chains));
    await rememberExclusions("category", strs(body.categories));
    return Response.json({ ok: true });
  } catch (caught) {
    captureError(caught, "/api/search/exclusions");
    return Response.json({ ok: false, error: "Could not save exclusions." }, { status: 502 });
  }
}
