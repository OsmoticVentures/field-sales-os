/**
 * Who is signed in, for the screens: name and which screens to show. The
 * screen list here only decides what the nav draws; the gate itself is
 * hasAccess(), which refuses a screen outside it whatever the nav shows.
 */
import { hasAccess } from "../../../lib/core/devices";
import { currentUser } from "../../../lib/core/user";
import { flagsFor } from "../../../lib/core/flags";

export async function GET() {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const u = await currentUser();
  const flags = await flagsFor(u.id);
  return Response.json(
    { ok: true, user: { id: u.id, name: u.name, features: u.features, flags } },
    { headers: { "cache-control": "no-store" } },
  );
}
