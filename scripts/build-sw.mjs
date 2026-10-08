// Writes public/sw.js from scripts/sw.template.js after `next build`, with
// this build's id, every file under .next/static, and the screens Next
// prerendered as static. Run by `pnpm build`. See OFFLINE.md.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const next = join(root, ".next");
const BASE = "/nb";

const build = readFileSync(join(next, "BUILD_ID"), "utf8").trim();

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const staticDir = join(next, "static");
const assets = walk(staticDir)
  .filter((p) => !p.endsWith(".map"))
  .map((p) => `${BASE}/_next/static/${relative(staticDir, p).split(sep).join("/")}`)
  .sort();

// Prerendered pages only: no root redirect, no internal error pages, no files.
const manifest = JSON.parse(readFileSync(join(next, "prerender-manifest.json"), "utf8"));
const shells = Object.keys(manifest.routes ?? {})
  .filter((r) => r !== "/" && !r.startsWith("/_") && !r.split("/").pop().includes(".") && !r.includes("["))
  .map((r) => `${BASE}${r}`)
  .sort();

const template = readFileSync(join(root, "scripts", "sw.template.js"), "utf8");
const out = template
  .replace('"__BUILD__"', JSON.stringify(build))
  .replace("__ASSETS__", JSON.stringify(assets))
  .replace("__SHELLS__", JSON.stringify(shells));

const pub = join(root, "public");
if (!existsSync(pub)) mkdirSync(pub);
writeFileSync(join(pub, "sw.js"), out);
console.log(`sw.js: build ${build}, ${assets.length} files, screens ${shells.join(" ")}`);
