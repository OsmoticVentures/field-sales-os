/**
 * The map's show-chains/practices/prospects toggles. Persisted, semi-
 * permanent same as the source app (nb_ui_prefs id=1), not component state
 * that resets on reload.
 */
import { setShowChainAccounts, setShowPracticeAccounts, setShowProspectAccounts } from "../../../../lib/features/route/dal";
import { hasAccess } from "../../../../lib/core/devices";
import { idempotencyKey, withIdempotency } from "../../../../lib/core/idempotency";

export const runtime = "nodejs";

const SETTERS = {
  chains: setShowChainAccounts,
  practices: setShowPracticeAccounts,
  prospects: setShowProspectAccounts,
} as const;

export async function POST(req: Request) {
  if (!(await hasAccess())) {
    return Response.json({ ok: false, error: "Sign in again." }, { status: 401 });
  }
  const key = idempotencyKey(req);
  if (!key) return Response.json({ ok: false, error: "Idempotency-Key header is required." }, { status: 400 });

  let body: { pref?: keyof typeof SETTERS; show?: boolean };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "Expected JSON." }, { status: 400 });
  }
  const setter = body.pref ? SETTERS[body.pref] : undefined;
  if (!setter || typeof body.show !== "boolean") {
    return Response.json({ ok: false, error: "pref (chains|practices|prospects) and show are required." }, { status: 400 });
  }

  try {
    const { replayed } = await withIdempotency(`route:map-prefs:${key}`, async () => {
      await setter(body.show!);
      return { pref: body.pref, show: body.show };
    });
    return Response.json({ ok: true, replayed });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "Couldn't save that." }, { status: 500 });
  }
}
