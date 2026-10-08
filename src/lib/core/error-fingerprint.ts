/**
 * What makes two errors "the same error": pure, no server or browser import,
 * so the route handler, the instrumentation hook and the unit test all agree.
 *
 * A fingerprint is kind + normalized message + top app frame + route. Each
 * part drops what changes between occurrences of one bug but not between two
 * different bugs:
 *  - message: ids, numbers, uuids, hashes and quoted values become a token,
 *    so "nb_accounts 4411 not found" and "nb_accounts 9 not found" group.
 *  - frame: the first stack line that is ours, with build hashes and
 *    line:column stripped, because both change on every deploy.
 *  - route: the path with id segments collapsed ("/api/account/[id]").
 */

export type ErrorKind = "server" | "client" | "upstream";

export function normalizeMessage(msg: string): string {
  return (msg || "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/"[^"]{0,200}"|'[^']{0,200}'|`[^`]{0,200}`/g, "<str>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** Collapse id-like path segments so one screen is one route. */
export function normalizeRoute(path: string): string {
  if (!path) return "";
  const bare = path.split("?")[0].split("#")[0].replace(/^\/nb(?=\/|$)/, "") || "/";
  return bare
    .split("/")
    .map((seg) => (/^\d+$|^[0-9a-f-]{16,}$|^[A-Za-z]+_[0-9a-f]{4,}$/i.test(seg) ? "[id]" : seg))
    .join("/")
    .slice(0, 200);
}

const IGNORED_FRAME = /node_modules|node:|instrumentation|upstream-watch|lib\/core\/errors|<anonymous>|\(native\)|webpack-runtime|next\/dist|react-dom|turbopack-runtime/;

/** The first stack frame that is this app's own code, deploy-stable. */
export function topFrame(stack: string | undefined): string {
  if (!stack) return "";
  const lines = stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at ") || l.includes("@"));
  const pick = lines.find((l) => !IGNORED_FRAME.test(l)) ?? lines[0] ?? "";
  return pick
    .replace(/https?:\/\/[^/\s)]+/g, "")
    .replace(/(\(|\s)[^\s(]*?\/(\.next\/)/, "$1$2")
    .replace(/__[A-Za-z0-9~_-]+\._\.js/g, ".js")
    .replace(/\?[^\s:)]*/g, "")
    .replace(/[-.][0-9a-f]{8,}(?=\.js)/gi, "")
    .replace(/:\d+:\d+\)?$/, "")
    .replace(/:\d+:\d+/g, "")
    .replace(/\(\s*$/, "")
    .trim()
    .slice(0, 300);
}

/** 64 bits of FNV-1a as 16 hex chars. Synchronous so a hot path never awaits it. */
export function hash64(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** `frame` is topFrame(stack), or a caller's own stand-in when there is no useful stack. */
export function fingerprint(kind: ErrorKind, message: string, frame: string, route: string): string {
  return hash64([kind, normalizeMessage(message), frame, normalizeRoute(route)].join("|")).slice(0, 12);
}

/**
 * The write throttle, per server instance. Returns how many hits to write now
 * (this one plus any folded in since the last write), or 0 to hold it. A held
 * hit rides the next write of the same fingerprint; one still held when the
 * instance goes cold is lost, so a stored count is a floor, never inflated.
 */
export function makeAdmitter(sameFpMs: number, maxPerMinute: number) {
  const recent = new Map<string, { at: number; pending: number }>();
  let windowStart = 0;
  let windowWrites = 0;
  return function admit(fp: string, now = Date.now()): number {
    const seen = recent.get(fp);
    if (seen && now - seen.at < sameFpMs) {
      seen.pending += 1;
      return 0;
    }
    if (now - windowStart >= 60_000) {
      windowStart = now;
      windowWrites = 0;
    }
    if (windowWrites >= maxPerMinute) {
      if (seen) seen.pending += 1;
      return 0;
    }
    windowWrites += 1;
    const hits = 1 + (seen?.pending ?? 0);
    recent.delete(fp);
    recent.set(fp, { at: now, pending: 0 });
    if (recent.size > 500) recent.delete(recent.keys().next().value as string);
    return hits;
  };
}
