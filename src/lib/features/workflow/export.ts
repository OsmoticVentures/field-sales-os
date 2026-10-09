/**
 * Plain-text exports of the Workflow screen's documents: a map as one
 * Markdown table (plus its notes and a count of who runs what), a folder
 * tree as an indented list. Pure functions over the types; the screen puts
 * the string on the clipboard or in a file.
 */

import { FILTERS, type Filter, type Folder, type FolderTree, type WorkflowMap } from "./types";

const cell = (s: string | undefined): string => (s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const filterLabel = (f: Filter): string => (f === "AUTO" ? FILTERS.AUTO.label : `${f}: ${FILTERS[f].label}`);

export function mapToMarkdown(map: WorkflowMap): string {
  const phaseName = new Map(map.phases.map((p) => [p.id, p.name]));
  const lines: string[] = [`# ${map.title}`];
  if (map.summary) lines.push("", map.summary);
  lines.push(
    "",
    "| Step ID | Step | Phase | Actor (now → target) | Typology | Input payload | Output payload | Filter | Tool |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const s of map.steps) {
    const cells = [
      s.id,
      s.name,
      phaseName.get(s.phase) ?? s.phase,
      `${s.actorNow} → ${s.actorTarget}`,
      s.typology,
      s.input,
      s.output,
      filterLabel(s.filter),
      s.tool,
    ];
    lines.push(`| ${cells.map(cell).join(" | ")} |`);
  }

  const notes = map.steps.filter((s) => s.note);
  if (notes.length) {
    lines.push("");
    for (const s of notes) lines.push(`Note, ${s.id}: ${s.note}`);
  }

  const count = (f: Filter) => map.steps.filter((s) => s.filter === f).length;
  lines.push(
    "",
    `${map.steps.length} steps: ${count("F1")} n8n, ${count("F2")} extraction, ${count("AUTO")} agents, ${count("F3")} gates`,
  );
  return lines.join("\n");
}

function folderLines(f: Folder, depth: number, out: string[]): void {
  let line = "  ".repeat(depth) + f.name;
  if (f.purpose) line += ` · ${f.purpose}`;
  if (f.steps && f.steps.length) line += ` [${f.steps.join(", ")}]`;
  out.push(line);
  for (const c of f.children) folderLines(c, depth + 1, out);
}

export function treeToText(tree: FolderTree): string {
  const out: string[] = [];
  folderLines(tree.root, 0, out);
  return out.join("\n");
}
