/**
 * HubSpot CRM v3 client, trimmed for Visit Logger. Ported from
 * portfolio/src/app/nutribiotic/lib/hubspot.ts, keeping the parts that
 * matter for filing a Note/Call/Meeting: every call is logged with its
 * normalized payload hash, owner scope is asserted against the live record,
 * and nothing mutates unless NB_HUBSPOT_WRITE_ENABLED is exactly "true".
 *
 * NOT PORTED (see the handback for why): the pushable-properties derivation
 * (hubspot-fields.ts, company property sync), repairDerivedDomain, and the
 * association-leak auto-detach. None of those are needed to file one
 * deterministic engagement, and this port's HubSpot write path has not been
 * exercised against production either way, since NB_HUBSPOT_WRITE_ENABLED
 * stays off per this milestone's own instruction.
 */
import "server-only";
import { payloadHash } from "./hubspot-hash";
import { logHubspotCall } from "./dal";

const BASE = "https://api.hubapi.com";
const BATCH_MAX = 100;

/** Juan's HubSpot owner id. Hardcoded exactly as the source does: the scope
 *  guard must never widen by a config edit or a caller argument. */
export const OWNER_ID = "36242368";

const token = (): string => process.env.NB_HUBSPOT_TOKEN ?? "";

/** Writes are off unless explicitly "true". Anything else, including unset,
 *  leaves this path read-only, so a typo fails safe. */
export const writeEnabled = (): boolean => process.env.NB_HUBSPOT_WRITE_ENABLED === "true";

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
};

export async function request<T = Record<string, unknown>>(opts: RequestOpts): Promise<T> {
  const { method, path, body, entity = "-", operation = "call", retries = 3 } = opts;

  if (!token()) {
    throw new ScopeError("HubSpot is not configured: NB_HUBSPOT_TOKEN is unset on this deployment.");
  }

  const direction = method === "GET" || path.endsWith("/read") || path.endsWith("/search") ? "pull" : "push";
  if (direction === "push" && !writeEnabled()) {
    throw new ScopeError(
      `Refusing ${method} ${path}: NB_HUBSPOT_WRITE_ENABLED is not "true". This path is dry by default.`,
    );
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
export async function assertJuansBook(companyIds: string[]): Promise<ScopeVerdict> {
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
