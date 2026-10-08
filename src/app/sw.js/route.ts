/**
 * /nb/sw.js, the service worker (OFFLINE.md). Rendered once at build time
 * (force-static), when .next/static already holds this build's files: it
 * fills scripts/sw.template.js with the list of those files and the screens
 * that are static. A route rather than a file in public/, because the
 * deploy does not pick up a file written after `next build`.
 *
 * A screen counts as static only when its page.tsx says force-static: those
 * render no rep data on the server, so the worker may keep one copy for
 * every rep. Anything else is treated as a rep's screen.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const dynamic = "force-static";

const BASE = "/nb";

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function staticScreens(root: string): string[] {
  const dir = join(root, "src", "app", "(app)");
  const out: string[] = [];
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const page = join(dir, name, "page.tsx");
    if (/^[a-z][a-z0-9-]*$/.test(name) && existsSync(page) && /dynamic\s*=\s*["']force-static["']/.test(readFileSync(page, "utf8"))) {
      out.push(`${BASE}/${name}`);
    }
  }
  return out.sort();
}

export function GET() {
  const root = process.cwd();
  const staticDir = join(root, ".next", "static");
  const assets = walk(staticDir)
    .filter((p) => !p.endsWith(".map"))
    .map((p) => `${BASE}/_next/static/${relative(staticDir, p).split(sep).join("/")}`)
    .sort();
  const shells = staticScreens(root);
  const build = createHash("sha256").update(JSON.stringify([assets, shells])).digest("hex").slice(0, 16);
  const template = readFileSync(join(root, "scripts", "sw.template.js"), "utf8");
  const body = template
    .replace('"__BUILD__"', JSON.stringify(build))
    .replace("__ASSETS__", JSON.stringify(assets))
    .replace("__SHELLS__", JSON.stringify(shells));
  return new Response(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-cache, no-store, must-revalidate",
      "service-worker-allowed": BASE,
    },
  });
}
