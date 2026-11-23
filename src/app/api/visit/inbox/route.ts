/**
 * The Visit screen's view of the note inbox (waiting.ts): what has not filed
 * and needs his eye. A note the Mac could not place shows at once with the
 * closest stores to tap; anything else shows only once it has been stuck
 * three hours, in red. A note filed but still refused by HubSpot three hours
 * on shows too. Read when the Visit screen opens, never polled.
 *
 * GET -> { notes: [...], hubspot: [...] }
 * POST { action: "place", key, account_id } files it to that store with the
 *      read already made; { action: "retry", key } reads it again;
 *      { action: "discard", key } removes it.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { currentUser } from "../../../../lib/core/user";
import { listUnfiled, settleWaiting, withdrawWaiting } from "../../../../lib/features/visit/waiting";
import { fileToPicked } from "../../../../lib/features/visit/waiting-file";
import { invalidatePriorityBook } from "../../../../lib/features/prospect/dal";

export const runtime = "nodejs";
export const maxDuration = 60;

const STUCK_MS = 3 * 3600_000;
const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";

async function sbGet<T>(path: string): Promise<T[]> {
  if (!SB_URL || !SB_KEY) return [];
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    cache: "no-store",
    signal: AbortSignal.timeout(6_000),
  }).catch(() => null);
  return res?.ok ? ((await res.json()) as T[]) : [];
}

export async function GET() {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const me = await currentUser();
  const now = Date.now();
  const notes = (await listUnfiled(me.id))
    .filter((n) => n.status === "needs_account" || n.status === "failed" || now - Date.parse(n.created_at) > STUCK_MS)
    .map((n) => ({
      key: n.key,
      label: n.account_name ?? n.text.trim().split(/\s+/).slice(0, 6).join(" "),
      status: n.status,
      error: n.error,
      sentAt: n.created_at,
      picks: n.status === "needs_account" && n.needs
        ? [
            ...(n.needs.matchAccountId && n.needs.matchAccountName ? [{ id: n.needs.matchAccountId, name: n.needs.matchAccountName, city: null }] : []),
            ...n.needs.candidates.filter((c) => c.id !== n.needs?.matchAccountId),
          ].slice(0, 3)
        : [],
    }));

  const cutoff = new Date(now - STUCK_MS).toISOString();
  const retry = await sbGet<{ activity_id: number; last_error: string | null }>(
    `nb_hubspot_retry?done_at=is.null&created_at=lt.${cutoff}&select=activity_id,last_error&limit=20`,
  );
  let hubspot: { activityId: number; label: string; error: string | null }[] = [];
  if (retry.length) {
    const acts = await sbGet<{ id: number; account_id: string; hubspot_engagement_id: string | null }>(
      `nb_activities?id=in.(${retry.map((r) => r.activity_id).join(",")})&select=id,account_id,hubspot_engagement_id`,
    );
    const open = acts.filter((a) => !a.hubspot_engagement_id);
    const names = open.length
      ? await sbGet<{ id: string; name: string }>(`nb_accounts?id=in.(${open.map((a) => `"${a.account_id}"`).join(",")})&select=id,name`)
      : [];
    hubspot = open.map((a) => ({
      activityId: a.id,
      label: names.find((n) => n.id === a.account_id)?.name ?? "A filed note",
      error: retry.find((r) => r.activity_id === a.id)?.last_error ?? null,
    }));
  }
  return Response.json({ ok: true, result: { notes, hubspot } });
}

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  const body = await req.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key : "";
  if (!key) return Response.json({ ok: false, error: "key is required." }, { status: 400 });
  const action = body?.action;
  if (action === "discard") {
    await withdrawWaiting(key);
    return Response.json({ ok: true, result: { status: "withdrawn" } });
  }
  if (action === "retry") {
    await settleWaiting(key, "waiting", { error: null, attempts: 0, next_at: new Date().toISOString() });
    return Response.json({ ok: true, result: { status: "waiting" } });
  }
  if (action === "place") {
    const accountId = typeof body?.account_id === "string" ? body.account_id : "";
    if (!accountId) return Response.json({ ok: false, error: "account_id is required." }, { status: 400 });
    invalidatePriorityBook();
    const result = await fileToPicked(key, accountId);
    if (result.status === "filed" || result.status === "withdrawn") return Response.json({ ok: true, result });
    return Response.json({ ok: false, error: "error" in result ? result.error : "That note did not file." }, { status: 422 });
  }
  return Response.json({ ok: false, error: "Unknown action." }, { status: 400 });
}
