/**
 * Payload normalization and hashing for HubSpot calls.
 *
 * BYTE-IDENTICAL TO PYTHON OR IT IS WORSE THAN USELESS. Ported verbatim from
 * portfolio/src/app/nutribiotic/lib/hubspot-hash.ts, which is itself a port of
 * `normalize()` and `payload_hash()` in bridges/nutribiotic/hubspot.py:84-98.
 * The partial unique index `nb_hubspot_push_idempotent` (migration 0007:85-87)
 * keys on (entity, local_id, payload_hash) where direction='push' and
 * status='ok'. Two writers reach that index: the Python scripts on the Mac
 * and this app. If their hashes disagree by a single byte, the index still
 * looks healthy while silently failing to dedupe.
 *
 * Run `nutribiotic/tests/hash_parity.py` after touching anything in this file.
 *
 * The four things Python does that a naive JSON.stringify does not:
 *
 *  1. NULLS ARE DROPPED FROM OBJECTS (but kept inside arrays).
 *  2. KEYS ARE SORTED BY CODE POINT.
 *  3. NON-ASCII IS ESCAPED (Python's json.dumps ensure_ascii=True).
 *  4. SEPARATORS ARE (",", ":") with no spaces.
 *
 * KNOWN LIMIT, floats: nothing this app sends to HubSpot is a float.
 */

/** Compare by Unicode code point, the way Python's `sorted()` orders strings. */
function codePointCompare(a: string, b: string): number {
  const ac = Array.from(a);
  const bc = Array.from(b);
  const n = Math.min(ac.length, bc.length);
  for (let i = 0; i < n; i++) {
    const d = (ac[i].codePointAt(0) ?? 0) - (bc[i].codePointAt(0) ?? 0);
    if (d !== 0) return d;
  }
  return ac.length - bc.length;
}

/** Deterministic shape for hashing: sorted keys, nulls dropped, fixed floats. */
export function normalize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return null;
  if (Array.isArray(obj)) return obj.map(normalize);
  if (typeof obj === "number") {
    if (!Number.isFinite(obj)) {
      throw new Error(`Refusing to hash a non-finite number (${obj}).`);
    }
    return Number.isInteger(obj) ? obj : round6(obj);
  }
  if (typeof obj === "object") {
    const src = obj as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort(codePointCompare)) {
      const v = src[k];
      if (v === null || v === undefined) continue;
      out[k] = normalize(v);
    }
    return out;
  }
  return obj;
}

/** Round half to even, matching Python's `round()`. */
function round6(x: number): number {
  const scaled = x * 1e6;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (diff > 0.5) rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return rounded / 1e6;
}

/** Escape a string the way Python's json.dumps does with ensure_ascii=True. */
function encodeString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const code = s.charCodeAt(i);
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\n") out += "\\n";
    else if (c === "\r") out += "\\r";
    else if (c === "\t") out += "\\t";
    else if (c === "\b") out += "\\b";
    else if (c === "\f") out += "\\f";
    else if (code < 0x20 || code > 0x7e) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else out += c;
  }
  return out + '"';
}

function encodeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`Refusing to hash a non-finite number (${n}).`);
  }
  return String(n);
}

/** json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=True) */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return encodeNumber(value);
  if (typeof value === "string") return encodeString(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const src = value as Record<string, unknown>;
    const keys = Object.keys(src).sort(codePointCompare);
    return "{" + keys.map((k) => encodeString(k) + ":" + canonicalJson(src[k])).join(",") + "}";
  }
  throw new Error(`Refusing to hash an unserializable value of type ${typeof value}.`);
}

/** sha256 of the canonical form. Mirrors hubspot.py:95-98. */
export async function payloadHash(body: unknown): Promise<string> {
  const canonical = canonicalJson(normalize(body));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
