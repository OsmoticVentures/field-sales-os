/**
 * The Scriptable widget's bearer auth. Its own secret (NB_WIDGET_TOKEN),
 * separate from NB_SESSION_SECRET (which signs the PIN cookie): a copy of
 * that sitting in a script on a phone would be a session-minting key left in
 * a pocket, this one grants exactly the widget's own two reads/writes and
 * rotates in Vercel without signing Juan out of anything.
 *
 * Since 2026-11-23 it is also the pass of the app's native note copy
 * (ios/App/App/NoteOutbox.swift), which may only put one of Juan's notes in
 * the server's inbox (api/visit/touchpoint), nothing more.
 */
import "server-only";
import { timingSafeEqual } from "../../core/session";

export async function hasWidgetToken(req: Request): Promise<boolean> {
  const configured = process.env.NB_WIDGET_TOKEN;
  if (!configured) return false;
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!bearer) return false;
  return timingSafeEqual(bearer, configured);
}
