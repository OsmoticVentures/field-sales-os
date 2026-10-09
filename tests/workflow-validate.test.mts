// The Workflow document validator (src/lib/features/workflow/validate.ts):
// a seed-shaped map and tree pass, every rule has a failing case, the size
// cap holds, extra keys are ignored. Pure, nothing here touches a store.
// Run: node --experimental-strip-types tests/workflow-validate.test.mts
import { MAX_DOC_BYTES, MAX_FOLDERS, MAX_STEPS } from "../src/lib/features/workflow/types.ts";
import { validateDoc } from "../src/lib/features/workflow/validate.ts";

let failures = 0;
const t = (name: string, ok: boolean, info?: unknown) => {
  if (!ok) {
    failures++;
    console.error("FAIL", name, info ?? "");
  } else console.log("ok  ", name);
};

// Fixtures, the shape of seed.ts in miniature.
const step = (id: string, phase: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: "Collect source material",
  phase,
  actorNow: "Human",
  actorTarget: "System",
  typology: "Deterministic",
  input: "Spec sheets in a Drive folder",
  output: "File record (.json)",
  filter: "F1",
  ...extra,
});
const map = (extra: Record<string, unknown> = {}) => ({
  title: "Collateral pipeline",
  summary: "From source material to a published sheet.",
  phases: [
    { id: "src", name: "Source" },
    { id: "clm", name: "Claims" },
  ],
  steps: [step("src_01_intake", "src"), step("clm_01_extract", "clm", { filter: "F2", tool: "n8n Drive trigger" })],
  ...extra,
});
const folder = (id: string, name: string, children: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  id,
  name,
  children,
  ...extra,
});
const tree = (extra: Record<string, unknown> = {}) => ({
  title: "Collateral Drive",
  root: folder("root", "Collateral", [
    folder("in", "01 Inbox", [], { purpose: "Raw source material", steps: ["src_01_intake"] }),
    folder("out", "02 Published", []),
  ]),
  ...extra,
});
const ok = (board: "maps" | "folders", data: unknown) => validateDoc(board, data) === null;
const fails = (board: "maps" | "folders", data: unknown, pattern: RegExp) => {
  const err = validateDoc(board, data);
  return typeof err === "string" && pattern.test(err);
};

// Valid documents
t("a seed-like map is valid", ok("maps", map()), validateDoc("maps", map()));
t("a seed-like tree is valid", ok("folders", tree()), validateDoc("folders", tree()));
t("an empty map is valid", ok("maps", { title: "New map", phases: [], steps: [] }));
t("a map with no summary is valid", ok("maps", map({ summary: undefined })));
t("a step in an unknown phase is allowed (shown as unplaced)", ok("maps", map({ steps: [step("x", "nowhere")] })));
t("extra keys on a map, a step and a folder are ignored", ok("maps", map({ color: "red", steps: [step("a", "src", { owner: "Juan" })] })) && ok("folders", tree({ icon: "box", root: folder("r", "Root", [], { color: 1 }) })));

// Not a document at all
t("null is rejected", fails("maps", null, /shape/));
t("an array is rejected", fails("maps", [], /shape/));
t("a string is rejected", fails("maps", "hi", /shape/));
t("an unknown board is rejected", fails("notes" as unknown as "maps", map(), /^Unknown board\.$/));
t("validateDoc never throws on a cyclic object", (() => {
  const c: Record<string, unknown> = { title: "x" };
  c.self = c;
  return typeof validateDoc("maps", c) === "string";
})());

// Size cap
t("a document over MAX_DOC_BYTES is too large", fails("maps", map({ summary: "x".repeat(MAX_DOC_BYTES) }), /too large/));

// Map rules
t("a map needs a title", fails("maps", map({ title: "" }), /^A map needs a title\.$/));
t("a map title over 120 chars", fails("maps", map({ title: "x".repeat(121) }), /title/));
t("a summary over 600 chars", fails("maps", map({ summary: "x".repeat(601) }), /summary/));
t("phases must be an array", fails("maps", map({ phases: {} }), /phases/));
t("at most 30 phases", fails("maps", map({ phases: Array.from({ length: 31 }, (_, i) => ({ id: `p${i}`, name: "P" })) }), /30 phases/));
t("a phase id must match the slug shape", fails("maps", map({ phases: [{ id: "Bad-Id", name: "P" }] }), /phase id/i));
t("a phase id over 24 chars", fails("maps", map({ phases: [{ id: "a".repeat(25), name: "P" }] }), /phase id/i));
t("a phase needs a name", fails("maps", map({ phases: [{ id: "src", name: "" }] }), /Phase names/));
t("phase ids must be unique", fails("maps", map({ phases: [{ id: "src", name: "A" }, { id: "src", name: "B" }] }), /src appears twice/));
t("steps must be an array", fails("maps", map({ steps: "none" }), /steps/));
t(`at most ${MAX_STEPS} steps`, fails("maps", map({ steps: Array.from({ length: MAX_STEPS + 1 }, (_, i) => step(`s${i}`, "src")) }), /at most 100 steps/));
t("a step id must match the slug shape", fails("maps", map({ steps: [step("Src 01", "src")] }), /step id/i));
t("a step id over 40 chars", fails("maps", map({ steps: [step("a".repeat(41), "src")] }), /step id/i));
t("step ids must be unique, naming the id", fails("maps", map({ steps: [step("src_01_intake", "src"), step("src_01_intake", "src")] }), /^Step ids must be unique: src_01_intake appears twice\.$/));
t("a step needs a name", fails("maps", map({ steps: [step("a", "src", { name: "" })] }), /needs a name/));
t("a step name over 160 chars", fails("maps", map({ steps: [step("a", "src", { name: "x".repeat(161) })] }), /needs a name/));
t("a step needs a phase string", fails("maps", map({ steps: [step("a", "src", { phase: 3 })] }), /phase/));
for (const key of ["actorNow", "actorTarget", "typology", "input", "output"]) {
  t(`${key} must be a string`, fails("maps", map({ steps: [step("a", "src", { [key]: 7 })] }), new RegExp(key)));
  t(`${key} over 600 chars`, fails("maps", map({ steps: [step("a", "src", { [key]: "x".repeat(601) })] }), new RegExp(key)));
}
t("filter must be F1, F2, F3 or AUTO", fails("maps", map({ steps: [step("a", "src", { filter: "F4" })] }), /filter/));
t("tool over 600 chars", fails("maps", map({ steps: [step("a", "src", { tool: "x".repeat(601) })] }), /tool/));
t("note must be a string when present", fails("maps", map({ steps: [step("a", "src", { note: 1 })] }), /note/));
t("tool and note may be absent", ok("maps", map({ steps: [step("a", "src", { tool: undefined, note: undefined })] })));

// Tree rules
t("a tree needs a title", fails("folders", tree({ title: "" }), /title/));
t("a tree needs a root folder", fails("folders", tree({ root: null }), /root/));
t("a folder needs an id", fails("folders", tree({ root: folder("", "Root") }), /needs an id/));
t("a folder id over 40 chars", fails("folders", tree({ root: folder("a".repeat(41), "Root") }), /needs an id/));
t("folder names are required", fails("folders", tree({ root: folder("r", "") }), /^Folder names are required\.$/));
t("a folder name over 120 chars", fails("folders", tree({ root: folder("r", "x".repeat(121)) }), /Folder names/));
t("purpose over 300 chars", fails("folders", tree({ root: folder("r", "Root", [], { purpose: "x".repeat(301) }) }), /purpose/));
t("steps must be a list of strings", fails("folders", tree({ root: folder("r", "Root", [], { steps: [1] }) }), /steps/));
t("steps over 50 entries", fails("folders", tree({ root: folder("r", "Root", [], { steps: Array.from({ length: 51 }, () => "s") }) }), /steps/));
t("a step id in a folder over 40 chars", fails("folders", tree({ root: folder("r", "Root", [], { steps: ["x".repeat(41)] }) }), /steps/));
t("children must be an array", fails("folders", tree({ root: folder("r", "Root", "none" as unknown as unknown[]) }), /children/));
t("a child must be a folder", fails("folders", tree({ root: folder("r", "Root", ["nope"]) }), /folder/i));
t("folder ids must be unique across the tree", fails("folders", tree({ root: folder("r", "Root", [folder("a", "A"), folder("b", "B", [folder("a", "A again")])]) }), /^Folder ids must be unique: a appears twice\.$/));
t(`at most ${MAX_FOLDERS} folders`, fails("folders", tree({ root: folder("r", "Root", Array.from({ length: MAX_FOLDERS }, (_, i) => folder(`f${i}`, "F"))) }), /^A tree holds at most 200 folders\.$/));
t(`${MAX_FOLDERS} folders in total is fine`, ok("folders", tree({ root: folder("r", "Root", Array.from({ length: MAX_FOLDERS - 1 }, (_, i) => folder(`f${i}`, "F"))) })));
{
  let deep: ReturnType<typeof folder> = folder("d13", "Leaf");
  for (let i = 12; i >= 1; i--) deep = folder(`d${i}`, "Level", [deep]);
  t("a tree nests at most 12 levels", fails("folders", tree({ root: deep }), /12 levels/));
  let fine: ReturnType<typeof folder> = folder("e12", "Leaf");
  for (let i = 11; i >= 1; i--) fine = folder(`e${i}`, "Level", [fine]);
  t("12 levels is fine", ok("folders", tree({ root: fine })));
}

if (failures) {
  console.error(`workflow-validate: ${failures} failing`);
  process.exitCode = 1;
} else console.log("workflow-validate: all cases pass");
