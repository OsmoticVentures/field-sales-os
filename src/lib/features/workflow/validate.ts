// Shape check for a Workflow document before it is stored: a map or a folder
// tree, per types.ts. Returns one plain sentence Juan can read inline, or null
// when the document is fine. Strict about shape, permissive about extra keys,
// and it never throws.
// The .ts extension is for the test runner (node strips types and needs it).
import { type Board, MAX_DOC_BYTES, MAX_FOLDERS, MAX_STEPS } from "./types.ts";

const STEP_ID = /^[a-z0-9_]{1,40}$/;
const PHASE_ID = /^[a-z0-9_]{1,24}$/;
const FILTERS = new Set(["F1", "F2", "F3", "AUTO"]);
const MAX_PHASES = 30;
const MAX_DEPTH = 12;
const MAX_FOLDER_STEPS = 50;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;
/** Absent (undefined or null) or a string up to max. */
const isOptStr = (v: unknown, max: number): boolean => v == null || isStr(v, 0, max);

export function validateDoc(board: Board, data: unknown): string | null {
  try {
    if (!isObj(data)) return "That document is not in a shape I can read.";
    if (JSON.stringify(data).length > MAX_DOC_BYTES) return "That document is too large.";
    if (board === "maps") return validateMap(data);
    if (board === "folders") return validateTree(data);
    return "Unknown board.";
  } catch {
    return "That document could not be checked.";
  }
}

function validateMap(d: Obj): string | null {
  if (!isStr(d.title, 1, 120)) return "A map needs a title.";
  if (!isOptStr(d.summary, 600)) return "A map summary holds at most 600 characters.";

  if (!Array.isArray(d.phases)) return "A map needs a list of phases.";
  if (d.phases.length > MAX_PHASES) return `A map holds at most ${MAX_PHASES} phases.`;
  const phaseIds = new Set<string>();
  for (const p of d.phases) {
    if (!isObj(p)) return "Every phase needs an id and a name.";
    if (typeof p.id !== "string" || !PHASE_ID.test(p.id))
      return "A phase id is 1 to 24 lowercase letters, digits or underscores.";
    if (!isStr(p.name, 1, 60)) return "Phase names are required.";
    if (phaseIds.has(p.id)) return `Phase ids must be unique: ${p.id} appears twice.`;
    phaseIds.add(p.id);
  }

  if (!Array.isArray(d.steps)) return "A map needs a list of steps.";
  if (d.steps.length > MAX_STEPS) return `A map holds at most ${MAX_STEPS} steps.`;
  const stepIds = new Set<string>();
  for (const s of d.steps) {
    if (!isObj(s)) return "Every step needs an id and a name.";
    if (typeof s.id !== "string" || !STEP_ID.test(s.id))
      return "A step id is 1 to 40 lowercase letters, digits or underscores.";
    if (stepIds.has(s.id)) return `Step ids must be unique: ${s.id} appears twice.`;
    stepIds.add(s.id);
    if (!isStr(s.name, 1, 160)) return `Step ${s.id} needs a name.`;
    if (typeof s.phase !== "string") return `Step ${s.id} needs a phase.`;
    for (const key of ["actorNow", "actorTarget", "typology", "input", "output"] as const) {
      if (!isStr(s[key], 0, 600)) return `Step ${s.id}: ${key} must be text of at most 600 characters.`;
    }
    if (typeof s.filter !== "string" || !FILTERS.has(s.filter))
      return `Step ${s.id} needs a filter of F1, F2, F3 or AUTO.`;
    if (!isOptStr(s.tool, 600)) return `Step ${s.id}: tool must be text of at most 600 characters.`;
    if (!isOptStr(s.note, 600)) return `Step ${s.id}: note must be text of at most 600 characters.`;
  }
  return null;
}

function validateTree(d: Obj): string | null {
  if (!isStr(d.title, 1, 120)) return "A tree needs a title.";
  if (!isObj(d.root)) return "A tree needs a root folder.";
  const ids = new Set<string>();
  const count = { n: 0 };
  return walkFolder(d.root, 1, ids, count);
}

function walkFolder(f: unknown, depth: number, ids: Set<string>, count: { n: number }): string | null {
  if (!isObj(f)) return "Every folder needs an id and a name.";
  if (depth > MAX_DEPTH) return `A tree nests at most ${MAX_DEPTH} levels deep.`;
  if (++count.n > MAX_FOLDERS) return `A tree holds at most ${MAX_FOLDERS} folders.`;
  if (!isStr(f.id, 1, 40)) return "Every folder needs an id.";
  if (ids.has(f.id)) return `Folder ids must be unique: ${f.id} appears twice.`;
  ids.add(f.id);
  if (!isStr(f.name, 1, 120)) return "Folder names are required.";
  if (!isOptStr(f.purpose, 300)) return `Folder ${f.name}: purpose holds at most 300 characters.`;
  if (f.steps != null) {
    if (!Array.isArray(f.steps) || f.steps.length > MAX_FOLDER_STEPS || !f.steps.every((s) => isStr(s, 0, 40)))
      return `Folder ${f.name}: steps is a list of at most ${MAX_FOLDER_STEPS} step ids.`;
  }
  if (!Array.isArray(f.children)) return `Folder ${f.name} needs a list of children.`;
  for (const c of f.children) {
    const err = walkFolder(c, depth + 1, ids, count);
    if (err) return err;
  }
  return null;
}
