/**
 * The Workflow screen's documents. GET ?board= lists one board; POST adds a
 * document, PUT replaces one whole (the client always sends the whole
 * document, so there is no PATCH), DELETE removes one. Every write answers
 * with the board's full list. The shape of a document is checked by
 * validateDoc before it is stored, so a malformed one never reaches a row.
 */
import { hasAccess } from "../../../lib/core/devices";
import { captureError } from "../../../lib/core/errors";
import { MAX_DOCS, boardOf, list, newId, put, remove, validId } from "../../../lib/features/workflow/store";
import { MAX_DOC_BYTES } from "../../../lib/features/workflow/types";
import { validateDoc } from "../../../lib/features/workflow/validate";

const NO_STORE = { "cache-control": "no-store" };
const fail = (error: string, status: number) => Response.json({ ok: false, error }, { status, headers: NO_STORE });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A database failure in plain words; the raw message goes to captureError. */
const plain = (err: unknown, fallback: string): string => {
  const m = err instanceof Error ? err.message : "";
  if (m.includes("PGRST205")) return "The workflow table is not set up yet.";
  if (m.includes("holds 20")) return "This board holds 20 documents.";
  return fallback;
};

export async function GET(req: Request) {
  if (!(await hasAccess())) return fail("Unauthorized.", 401);
  const board = boardOf(new URL(req.url).searchParams.get("board"));
  if (!board) return fail("Unknown board.", 400);
  try {
    return Response.json({ ok: true, items: await list(board) }, { headers: NO_STORE });
  } catch (err) {
    captureError(err, "/api/workflow");
    return fail(plain(err, "Could not load."), 500);
  }
}

async function write(req: Request, method: "POST" | "PUT" | "DELETE") {
  if (!(await hasAccess())) return fail("Unauthorized.", 401);
  let body: { board?: unknown; id?: unknown; data?: unknown };
  try { body = await req.json(); } catch { return fail("Bad request.", 400); }
  const board = boardOf(body.board);
  if (!board) return fail("Unknown board.", 400);

  try {
    if (method === "DELETE") {
      if (!validId(body.id)) return fail("Bad request.", 400);
      await remove(board, body.id);
      return Response.json({ ok: true, items: await list(board) }, { headers: NO_STORE });
    }

    if (!isObj(body.data)) return fail("Bad request.", 400);
    if (new TextEncoder().encode(JSON.stringify(body.data)).length > MAX_DOC_BYTES) return fail("That document is too large.", 413);
    const problem = validateDoc(board, body.data);
    if (problem) return fail(problem, 400);

    if (method === "POST") {
      if ((await list(board)).length >= MAX_DOCS) return fail(`This board holds ${MAX_DOCS} documents.`, 409);
      const id = newId();
      await put(board, id, body.data);
      return Response.json({ ok: true, id, items: await list(board) }, { headers: NO_STORE });
    }

    if (!validId(body.id)) return fail("Bad request.", 400);
    // A PUT under an id the board no longer holds is undo bringing a deleted
    // document back; it counts against the cap like any other insert.
    const current = await list(board);
    if (!current.some((x) => x.id === body.id) && current.length >= MAX_DOCS) return fail(`This board holds ${MAX_DOCS} documents.`, 409);
    await put(board, body.id, body.data);
    return Response.json({ ok: true, items: await list(board) }, { headers: NO_STORE });
  } catch (err) {
    captureError(err, "/api/workflow");
    return fail(plain(err, "Could not save."), 500);
  }
}

export const POST = (req: Request) => write(req, "POST");
export const PUT = (req: Request) => write(req, "PUT");
export const DELETE = (req: Request) => write(req, "DELETE");
