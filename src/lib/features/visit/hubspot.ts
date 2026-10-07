/**
 * HubSpot CRM v3 client, trimmed for Visit Logger. Ported from
 * portfolio/src/app/nutribiotic/lib/hubspot.ts, keeping the parts that
 * matter for filing a Note/Call/Meeting: every call is logged with its
 * normalized payload hash, owner scope is asserted against the live record,
 * and nothing mutates unless that call's own feature flag is exactly "true".
 *
 * SPLIT 2026-09-28 (Juan's ask): a single NB_HUBSPOT_WRITE_ENABLED used to
 * gate both Visit Logger's own filing and Outbound's "mark sent" filing
 * together, so there was no way to turn one on without the other. Every push
 * now names which feature it's filing for (HubspotFeature) and is gated on
 * that feature's own env var. Unset or anything other than "true" leaves
 * that one feature read-only, so a typo or a missing var fails safe.
 *
 * NOT PORTED (see the handback for why): the pushable-properties derivation
 * (hubspot-fields.ts, company property sync), repairDerivedDomain, and the
 * association-leak auto-detach. None of those are needed to file one
 * deterministic engagement.
 */
import "server-only";
import { payloadHash } from "./hubspot-hash";
import { logHubspotCall } from "./dal";
import { myOwnerId } from "../../core/user";

const BASE = "https://api.hubapi.com";
const BATCH_MAX = 100;

/** The signed-in rep's HubSpot owner id (lib/core/user.ts). Resolved per
 *  request from the session, never from a caller argument, so the scope guard
 *  can only ever be the rep who is actually signed in. */
export const ownerId = myOwnerId;

const token = (): string => process.env.NB_HUBSPOT_TOKEN ?? "";

/** Which feature is asking to file into HubSpot. Every write-capable call
 *  names one explicitly; there is no default, so a missing feature is a
 *  compile error, not a silent fall-through to some other feature's flag. */
export type HubspotFeature = "visit" | "outbound";

const FEATURE_FLAG_ENV: Record<HubspotFeature, string> = {
  visit: "NB_HUBSPOT_VISIT_WRITE_ENABLED",
  outbound: "NB_HUBSPOT_OUTBOUND_WRITE_ENABLED",
};

/** Writes are off unless that feature's own flag is explicitly "true".
 *  Anything else, including unset, leaves this path read-only, so a typo
 *  fails safe. */
export const writeEnabled = (feature: HubspotFeature): boolean =>
  process.env[FEATURE_FLAG_ENV[feature]] === "true";

export class HubSpotError extends Error {
  constructor(readonly status: number, readonly body: string, method: string, path: string) {
    super(`${method} ${path} -> HTTP ${status}: ${body.slice(0, 400)}`);
    this.name = "HubSpotError";
  }
}

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RequestOpts = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  entity?: string;
  operation?: string;
  retries?: number;
  /** Required for any call that turns out to be a push (see `direction`
   *  below); a read-only call (GET, /read, /search) never needs it. */
  feature?: HubspotFeature;
};

export async function request<T = Record<string, unknown>>(opts: RequestOpts): Promise<T> {
  const { method, path, body, entity = "-", operation = "call", retries = 3, feature } = opts;

  if (!token()) {
    throw new ScopeError("HubSpot is not configured: NB_HUBSPOT_TOKEN is unset on this deployment.");
  }

  const direction = method === "GET" || path.endsWith("/read") || path.endsWith("/search") ? "pull" : "push";
  if (direction === "push") {
    if (!feature) {
      throw new ScopeError(`Refusing ${method} ${path}: no feature named for this push, cannot check its write flag.`);
    }
    if (!writeEnabled(feature)) {
      throw new ScopeError(
        `Refusing ${method} ${path}: ${FEATURE_FLAG_ENV[feature]} is not "true". This path is dry by default.`,
      );
    }
  }

  const phash = await payloadHash(body !== undefined ? body : { path });

  let delay = 1000;
  for (let attempt = 0; attempt < retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(BASE + path, {
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: "no-store",
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (attempt < retries - 1) {
        await logHubspotCall({ direction, entity, operation, payload_hash: phash, status: "network_error", error: message });
        await sleep(Math.max(delay, 5000));
        delay *= 2;
        continue;
      }
      await logHubspotCall({ direction, entity, operation, payload_hash: phash, status: "error", error: message });
      throw e;
    }

    const text = await res.text();
    if (res.ok) {
      const parsed = (text ? JSON.parse(text) : {}) as T;
      await logHubspotCall({ direction, entity, operation, payload_hash: phash, status: "ok", http_status: res.status, response: parsed });
      return parsed;
    }
    if ([429, 502, 503, 504].includes(res.status) && attempt < retries - 1) {
      await logHubspotCall({ direction, entity, operation, payload_hash: phash, status: "rate_limited", http_status: res.status, error: text });
      await sleep(delay);
      delay *= 2;
      continue;
    }
    await logHubspotCall({ direction, entity, operation, payload_hash: phash, status: "error", http_status: res.status, error: text });
    throw new HubSpotError(res.status, text, method, path);
  }
  throw new HubSpotError(429, "retries exhausted", method, path);
}

export async function batchRead(
  objectType: string,
  ids: string[],
  properties: string[],
): Promise<Array<{ id: string; properties: Record<string, string | null> }>> {
  const out: Array<{ id: string; properties: Record<string, string | null> }> = [];
  for (let i = 0; i < ids.length; i += BATCH_MAX) {
    const chunk = ids.slice(i, i + BATCH_MAX);
    const res = await request<{ results?: typeof out }>({
      method: "POST",
      path: `/crm/v3/objects/${objectType}/batch/read`,
      body: { properties, inputs: chunk.map((id) => ({ id })) },
      entity: objectType,
      operation: "batch_read",
    });
    out.push(...(res.results ?? []));
  }
  return out;
}

export type ScopeVerdict = { allowed: string[]; dropped: Array<{ id: string; owner: string | null }> };

/** The live-portal owner-scope assertion. The Supabase read that produced
 *  the company id is the first assertion; this re-reads the live record. */
export async function assertOwnBook(companyIds: string[]): Promise<ScopeVerdict> {
  const OWNER_ID = await ownerId();
  const unique = Array.from(new Set(companyIds.filter(Boolean)));
  if (unique.length === 0) return { allowed: [], dropped: [] };
  const live = await batchRead("companies", unique, ["hubspot_owner_id"]);
  const owners = new Map(live.map((r) => [r.id, r.properties?.hubspot_owner_id ?? null]));
  const allowed: string[] = [];
  const dropped: ScopeVerdict["dropped"] = [];
  for (const id of unique) {
    const owner = owners.get(id) ?? null;
    if (owner === OWNER_ID) allowed.push(id);
    else dropped.push({ id, owner });
  }
  return { allowed, dropped };
}
