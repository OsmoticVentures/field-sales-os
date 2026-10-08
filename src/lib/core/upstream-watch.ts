/**
 * Upstream failures, seen at the fetch layer. Node's fetch is undici, which
 * publishes every request on node:diagnostics_channel; subscribing there sees
 * every Supabase, HubSpot, Anthropic (the SDK uses fetch too) and Google call
 * without touching one dal or changing what any call returns. Read-only: a
 * subscriber cannot alter the request or the response.
 *
 * Reported: 400, 401, 403, 429 and 5xx answers, and calls that never got an
 * answer (DNS, reset, timeout). Not reported: 404/406/409, which this app's
 * own code treats as "not there" or "already there", and a deliberate abort.
 * Our own error RPC is skipped, so a down Supabase cannot report itself in a
 * loop.
 */

import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import dc from "node:diagnostics_channel";
import { capture, HIT_RPC } from "./errors";

type UndiciRequest = {
  origin?: string;
  method?: string;
  path?: string;
  __nbStack?: string;
  /** The caller's async context. The answer arrives on a pooled socket's own
   *  context, which may belong to another request: re-entering the caller's
   *  makes after() and the rep cookie the right request's. */
  __nbRun?: <R>(fn: () => R) => R;
};

const SERVICES: [RegExp, string][] = [
  [/\.supabase\.co$/, "Supabase"],
  [/^api\.hubapi\.com$/, "HubSpot"],
  [/^api\.anthropic\.com$/, "Anthropic"],
  [/\.googleapis\.com$/, "Google"],
];

const REPORTED = (s: number) => s === 400 || s === 401 || s === 403 || s === 429 || s >= 500;

function service(origin: string | undefined): string | null {
  if (!origin) return null;
  let host = "";
  try {
    host = new URL(origin).hostname;
  } catch {
    return null;
  }
  for (const [re, name] of SERVICES) if (re.test(host)) return name;
  return null;
}

/** "/rest/v1/nb_accounts?select=..." -> "/rest/v1/nb_accounts"; ids collapse. */
function endpoint(path: string | undefined): string {
  return (path ?? "")
    .split("?")[0]
    .split("/")
    .map((seg) => (/^\d+$|^[0-9a-f-]{16,}$/i.test(seg) ? "[id]" : seg))
    .join("/")
    .slice(0, 120);
}

function report(req: UndiciRequest, what: string): void {
  const name = service(req.origin);
  if (!name) return;
  const ep = endpoint(req.path);
  capture({
    kind: "upstream",
    message: `${name} ${what} on ${(req.method ?? "GET").toUpperCase()} ${ep}`,
    stack: req.__nbStack,
    // The upstream endpoint stands in for a frame (the caller's frame is in
    // the sample stack), so one broken call failing twice is one row.
    frame: `${name} ${ep}`,
    route: "",
  });
}

let installed = false;

export function watchUpstream(): void {
  if (installed) return;
  installed = true;

  dc.subscribe("undici:request:create", (msg) => {
    const req = (msg as { request: UndiciRequest }).request;
    if (!service(req.origin) || req.path?.startsWith(HIT_RPC)) return;
    // Deep enough to reach the app frame that called fetch, cheap enough to
    // take on a watched call only.
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 40;
    // Keep the app's frames; undici's own are the same on every call.
    req.__nbStack = (new Error("upstream call").stack ?? "")
      .split("\n")
      .filter((l) => !/node:|<anonymous>/.test(l))
      .join("\n");
    Error.stackTraceLimit = limit;
    req.__nbRun = AsyncLocalStorage.snapshot();
  });

  dc.subscribe("undici:request:headers", (msg) => {
    const { request, response } = msg as { request: UndiciRequest; response: { statusCode: number } };
    if (!request.__nbStack || !REPORTED(response.statusCode)) return;
    const run = request.__nbRun ?? ((fn) => fn());
    run(() => report(request, `answered ${response.statusCode}`));
  });

  dc.subscribe("undici:request:error", (msg) => {
    const { request, error } = msg as { request: UndiciRequest; error: Error };
    if (!request.__nbStack || error?.name === "AbortError") return;
    const what = `failed (${error?.name === "TimeoutError" ? "timed out" : error?.message?.slice(0, 80) || "no answer"})`;
    const run = request.__nbRun ?? ((fn) => fn());
    run(() => report(request, what));
  });
}
