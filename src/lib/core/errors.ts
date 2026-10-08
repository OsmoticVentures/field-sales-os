/**
 * Error capture, server side. Every failure worth fixing lands as one row per
 * distinct error in nb_app_errors (migration 0097, in the agency repo), which
 * bridges/clientos/errors_triage.py reads to propose a fix for Juan to approve.
 *
 * THREE WAYS IN:
 *  - captureError(err, route): a route handler's catch block, which answers
 *    the phone with a 500 and would otherwise only console.error.
 *  - onRequestError (src/instrumentation.ts): anything a handler or a server
 *    render did not catch.
 *  - captureUpstream (same file): a Supabase, HubSpot, Anthropic or Google
 *    call that came back 400/401/403/429/5xx or never came back, seen at the
 *    fetch layer so no call site has to remember to report it.
 *
 * BOUNDED AT THE SOURCE. One warm instance writes a given fingerprint at most
 * once every 10 seconds and folds the hits in between into the next write's
 * count, and writes at most 60 rows a minute in all. A storm is a handful of
 * tiny RPCs, not one per request. Hits still pending when an instance goes
 * cold are lost: `count` is a floor, never inflated.
 *
 * NEVER THROWS, never delays the response: the write runs in after() when
 * there is a request to attach it to, and every failure is swallowed. The rep
 * is the nb_users id from the signed cookie, never the PIN.
 */

import "server-only";
import { after } from "next/server";
import { fingerprint, makeAdmitter, normalizeRoute, topFrame, type ErrorKind } from "./error-fingerprint";
import { COOKIE, DEVICE_COOKIE, readAuthCookies, readDeviceToken, readSessionUser } from "./session";

const SB_URL = process.env.NB_SUPABASE_URL ?? "";
const SB_KEY = process.env.NB_SUPABASE_SERVICE_ROLE_KEY ?? "";
const COMMIT = (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 40) || null;

/** The RPC path. instrumentation.ts skips it, so reporting can never report itself. */
export const HIT_RPC = "/rest/v1/rpc/nb_app_error_hit";

/** One warm instance: a fingerprint at most every 10s, 60 writes a minute. */
const admit = makeAdmitter(10_000, 60);

export type Captured = {
  kind: ErrorKind;
  message: string;
  stack?: string;
  route: string;
  /** Overrides the frame parsed from `stack` (upstream calls have no useful one). */
  frame?: string;
  rep?: string | null;
};

/** The rep a raw Cookie header names, or null. onRequestError has the
 *  request's headers but runs outside the scope cookies() needs. */
export async function repFromCookieHeader(header: string | string[] | undefined): Promise<string | null> {
  try {
    const raw = Array.isArray(header) ? header.join("; ") : header ?? "";
    const jar = new Map(
      raw.split(";").map((p) => {
        const at = p.indexOf("=");
        return [p.slice(0, at).trim(), decodeURIComponent(p.slice(at + 1).trim())] as [string, string];
      }),
    );
    return await repFrom(jar.get(COOKIE), jar.get(DEVICE_COOKIE));
  } catch {
    return null;
  }
}

/** The rep a request's cookies name, or null. Never a default rep. */
export async function repFromCookies(): Promise<string | null> {
  try {
    const { session, device } = await readAuthCookies();
    return await repFrom(session, device);
  } catch {
    return null;
  }
}

async function repFrom(session: string | undefined, device: string | undefined): Promise<string | null> {
  try {
    const fromSession = await readSessionUser(session);
    if (fromSession) return fromSession;
    const claimed = await readDeviceToken(device);
    if (!claimed) return null;
    const at = claimed.indexOf("~");
    return at < 0 ? "juan" : claimed.slice(at + 1);
  } catch {
    return null;
  }
}

async function write(c: Captured, fp: string, frame: string, hits: number, rep: string | null): Promise<void> {
  if (!SB_URL || !SB_KEY) return;
  try {
    await fetch(`${SB_URL}${HIT_RPC}`, {
      method: "POST",
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        p_fingerprint: fp,
        p_kind: c.kind,
        p_route: normalizeRoute(c.route),
        p_message: (c.message || "Unknown error").slice(0, 500),
        p_top_frame: frame,
        p_stack: (c.stack ?? "").slice(0, 4000),
        p_rep_id: rep,
        p_commit_sha: COMMIT,
        p_hits: hits,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // Reporting must never become the failure.
  }
}

/** Record one error. Returns at once; the write rides after() when it can. */
export function capture(c: Captured): void {
  try {
    const frame = c.frame ?? topFrame(c.stack);
    const fp = fingerprint(c.kind, c.message, frame, c.route);
    const hits = admit(fp);
    if (!hits) return;
    const rep = c.rep !== undefined ? Promise.resolve(c.rep) : repFromCookies();
    const job = () => rep.then((r) => write(c, fp, frame, hits, r));
    try {
      after(job);
    } catch {
      void job(); // outside a request (a worker, a timer): best effort
    }
  } catch {
    // never throw from the reporter
  }
}

/** Same as capture() but awaitable, for onRequestError, which must finish its work. */
export async function captureNow(c: Captured): Promise<void> {
  try {
    const frame = c.frame ?? topFrame(c.stack);
    const fp = fingerprint(c.kind, c.message, frame, c.route);
    const hits = admit(fp);
    if (!hits) return;
    const rep = c.rep !== undefined ? c.rep : await repFromCookies();
    await write(c, fp, frame, hits, rep);
  } catch {
    // never throw from the reporter
  }
}

/**
 * The one line a caught failure adds, next to whatever it already logs:
 *   } catch (err) {
 *     captureError(err, "/api/visit/log");
 * `where` is the route for a handler, or "lib/<feature>/<module>" for a
 * library failure that has no route of its own.
 */
export function captureError(err: unknown, where: string): void {
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-Error thrown");
  capture({ kind: "server", message: `${e.name}: ${e.message}`, stack: e.stack, route: where });
}
