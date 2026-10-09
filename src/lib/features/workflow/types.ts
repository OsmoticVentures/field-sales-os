/**
 * The Workflow screen's two documents: a workflow map and a folder tree.
 *
 * A map is one pipeline, drawn step by step. Each step carries the five
 * blueprint fields (step, actor now and target, typology, input payload,
 * output payload) plus the filter result that decides what runs it: a
 * deterministic n8n node (F1), an extraction agent (F2), a human gate (F3),
 * or an autonomous agent (AUTO). Steps sit in phases (intake, claims,
 * plan, create, comply, render, publish, monitor) and run in array order.
 *
 * A folder tree is the Drive layout a map reads from and writes to: every
 * folder names its purpose and the step ids that touch it.
 *
 * Both are stored whole, one row per document, in nb_workflow_items
 * (supabase/0012_workflow_items.sql) behind /api/workflow, the same shape
 * as the roadmap (lib/features/roadmap). Nothing here is interpreted on the
 * server; the screen owns the document.
 */

export const BOARDS = ["maps", "folders"] as const;
export type Board = (typeof BOARDS)[number];

/** Who or what runs a step, the doc's "filter result". */
export type Filter = "F1" | "F2" | "F3" | "AUTO";

export const FILTERS: Record<Filter, { label: string; short: string }> = {
  F1: { label: "Deterministic (n8n)", short: "n8n" },
  F2: { label: "Extraction agent", short: "Extract" },
  F3: { label: "Human gate", short: "Gate" },
  AUTO: { label: "Autonomous agent", short: "Agent" },
};

/** Suggestions for free-text fields; the field accepts anything. */
export const TYPOLOGIES = [
  "Deterministic",
  "Extraction",
  "Extraction + evaluation",
  "Cognitive: evaluation",
  "Cognitive: synthesis",
  "Cognitive: creative",
  "Cognitive: low risk",
  "High-stakes approval",
] as const;

export const ACTORS = ["Human", "System", "Agent", "Agent proposes", "Agent + Canva", "Human stays"] as const;

export type Phase = {
  id: string; // short slug, the step id prefix: "src", "clm", "cmp"
  name: string; // "Source", "Claims", "Compliance"
};

export type Step = {
  id: string; // slug, unique within the map: "src_01_intake"
  name: string; // "Collect source material"
  phase: string; // Phase.id
  actorNow: string; // "Human"
  actorTarget: string; // "System", "Agent", "Human stays"
  typology: string;
  input: string; // "Spec sheets, COAs, studies (.pdf) in a Drive folder"
  output: string; // "File record (.json)"
  filter: Filter;
  tool?: string; // "n8n Drive trigger", "Canva autofill"
  note?: string;
};

export type WorkflowMap = {
  title: string;
  summary?: string;
  phases: Phase[];
  steps: Step[];
};

export type Folder = {
  id: string;
  name: string;
  purpose?: string; // one line: what lives here
  steps?: string[]; // step ids that read or write it
  children: Folder[];
};

export type FolderTree = {
  title: string;
  root: Folder;
};

/** Bounds, enforced in the API and the database trigger. */
export const MAX_DOCS = 20; // per board
export const MAX_STEPS = 100; // per map
export const MAX_FOLDERS = 200; // per tree
export const MAX_DOC_BYTES = 60000;

export type Item<T = Record<string, unknown>> = { id: string; data: T };

export const newId = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** "Collect source material" -> "collect_source_material" */
export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "step";

export const emptyMap = (title = "New map"): WorkflowMap => ({ title, phases: [], steps: [] });
export const emptyTree = (title = "New folder tree"): FolderTree => ({
  title,
  root: { id: newId(), name: title, children: [] },
});

export function countFolders(f: Folder): number {
  return 1 + f.children.reduce((n, c) => n + countFolders(c), 0);
}
