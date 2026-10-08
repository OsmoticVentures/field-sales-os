/**
 * The Marketing screen's roadmaps. GET ?board= lists one board; POST adds a
 * project, PATCH merges fields into one, PUT replaces one whole (undo), DELETE
 * removes one. Every write answers with the board's full list.
 */
import { hasAccess } from "../../../lib/core/devices";
import { MAX_ITEMS, boardOf, list, merge, newId, put, remove, validId } from "../../../lib/features/roadmap/store";

const NO_STORE = { "cache-control": "no-store" };
const fail = (error: string, status: number) => Response.json({ ok: false, error }, { status, headers: NO_STORE });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export async function GET(req: Request) {
  if (!(await hasAccess())) return fail("Unauthorized.", 401);
  const board = boardOf(new URL(req.url).searchParams.get("board"));
  if (!board) return fail("Unknown board.", 400);
  return Response.json({ ok: true, items: await list(board) }, { headers: NO_STORE });
}

async function write(req: Request, method: string) {
  if (!(await hasAccess())) return fail("Unauthorized.", 401);
  let body: { board?: unknown; id?: unknown; data?: unknown };
  try { body = await req.json(); } catch { return fail("Bad request.", 400); }
  const board = boardOf(body.board);
  if (!board) return fail("Unknown board.", 400);
  if (JSON.stringify(body.data ?? {}).length > 20000) return fail("That project is too large.", 413);

  if (method === "POST") {
    if (!isObj(body.data)) return fail("Bad request.", 400);
    if ((await list(board)).length >= MAX_ITEMS) return fail(`The roadmap holds ${MAX_ITEMS} projects.`, 409);
    const id = newId();
    await put(board, id, body.data);
    return Response.json({ ok: true, id, items: await list(board) }, { headers: NO_STORE });
  }

  if (!validId(body.id)) return fail("Bad request.", 400);
  if (method === "PATCH") {
    if (!isObj(body.data)) return fail("Bad request.", 400);
    if (!(await merge(board, body.id, body.data))) return fail("That project is gone.", 404);
  } else if (method === "PUT") {
    if (!isObj(body.data)) return fail("Bad request.", 400);
    await put(board, body.id, body.data);
  } else {
    await remove(board, body.id);
  }
  return Response.json({ ok: true, items: await list(board) }, { headers: NO_STORE });
}

export const POST = (req: Request) => write(req, "POST");
export const PATCH = (req: Request) => write(req, "PATCH");
export const PUT = (req: Request) => write(req, "PUT");
export const DELETE = (req: Request) => write(req, "DELETE");
