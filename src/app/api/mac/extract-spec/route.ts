/**
 * The touchpoint extraction's prompt and JSON schema, for the Mac's `cliente`
 * capture to read a note on Juan's Max plan (bridges/nutribiotic/clients.py)
 * instead of this server's metered key. It posts the read back to
 * api/mac/touchpoint as `mac_parsed`, where the same schema validates it.
 */
import { macAuthorized } from "../../../../lib/core/mac-auth";
import { extractionSpec } from "../../../../lib/features/visit/touchpoint";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!macAuthorized(req)) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  return Response.json({ ok: true, result: await extractionSpec() });
}
