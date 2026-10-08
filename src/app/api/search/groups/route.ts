/**
 * Search groups: named lists of businesses picked from a search (Palm Springs
 * Nutrition, Beverly Hills Beauty, ...). GET lists every group with its
 * members. POST does one of: create a group, add members, remove a member.
 * Every write is an upsert or a delete by key, so a replay changes nothing and
 * none takes an idempotency key.
 */
import { hasAccess } from "../../../../lib/core/devices";
import { addGroupMembers, createGroup, listGroups, removeGroupMember } from "../../../../lib/features/search/dal";
import { captureError } from "@/lib/core/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const MAX_ADD = 100;

export async function GET() {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  try {
    return Response.json({ ok: true, groups: await listGroups() });
  } catch (caught) {
    captureError(caught, "/api/search/groups");
    return Response.json({ ok: false, error: "Could not read the groups." }, { status: 502 });
  }
}

export async function POST(req: Request) {
  if (!(await hasAccess())) return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "Expected a JSON body." }, { status: 400 });
  }
  const action = String(body.action ?? "");
  try {
    if (action === "create") {
      const name = String(body.name ?? "").trim();
      if (!name) return Response.json({ ok: false, error: "Name the group." }, { status: 400 });
      return Response.json({ ok: true, group: await createGroup(name) });
    }
    const groupId = String(body.group_id ?? "").trim().slice(0, 80);
    if (!groupId) return Response.json({ ok: false, error: "Missing group." }, { status: 400 });
    if (action === "add") {
      const raw = Array.isArray(body.candidates) ? body.candidates.slice(0, MAX_ADD) : [];
      const members = raw.flatMap((c) => {
        const o = c as Record<string, unknown>;
        const placesId = typeof o?.places_id === "string" ? o.places_id : typeof o?.key === "string" ? o.key : "";
        if (!placesId) return [];
        return [{ places_id: placesId, name: typeof o.name === "string" ? o.name : null, candidate: o }];
      });
      if (!members.length) return Response.json({ ok: false, error: "Nothing to add." }, { status: 400 });
      await addGroupMembers(groupId, members);
      return Response.json({ ok: true, added: members.length });
    }
    if (action === "remove") {
      const placesId = String(body.places_id ?? "").trim();
      if (!placesId) return Response.json({ ok: false, error: "Missing business." }, { status: 400 });
      await removeGroupMember(groupId, placesId);
      return Response.json({ ok: true });
    }
    return Response.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (caught) {
    captureError(caught, "/api/search/groups");
    return Response.json({ ok: false, error: "Could not save that." }, { status: 502 });
  }
}
