/**
 * The Mac's doors (api/mac/*) are bearer-gated with NB_SESSION_SECRET: no
 * browser session, the Mac's `cliente` capture is the only caller, and with
 * no cookie a request acts as the default rep (Juan). Compared in constant time.
 */
import "server-only";
import { timingSafeEqual } from "./session";

export function macAuthorized(req: Request): boolean {
  const secret = process.env.NB_SESSION_SECRET;
  const sent = req.headers.get("authorization") ?? "";
  return Boolean(secret) && timingSafeEqual(sent, `Bearer ${secret}`);
}
