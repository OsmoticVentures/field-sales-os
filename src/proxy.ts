/**
 * Proxy (Next's replacement for middleware). Bounces an obviously
 * unauthenticated request to the gate before the page renders. Ported from
 * the NutriBiotic OS (portfolio/src/proxy.ts), scoped to this app's own
 * routes rather than a subtree of a bigger site.
 *
 * THIS IS NOT THE AUTHORIZATION GATE, and it must never become one: proxy
 * runs on every matched request including prefetches, so it may only read
 * the cookie optimistically and must never touch a database. The real gate
 * is `hasAccess()` (lib/core/devices.ts), which every route handler and the
 * layout call directly.
 *
 * PATHS HERE ARE BASEPATH-RELATIVE. This app's `basePath` is "/nb"
 * (next.config.ts); Next strips it before proxy sees `pathname`, so a rule
 * for "/gate" matches a browser request to "/nb/gate". Do not add "/nb" to
 * any path below, in this file or the matcher.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { COOKIE, DEVICE_COOKIE, readDeviceToken, verifyToken } from "./lib/core/session";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // The gate itself and every API route stay reachable while signed out:
  // the gate obviously needs to be, and api/auth is what mints the session.
  if (pathname === "/gate" || pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Home Screen manifests: iOS fetches one while installing a tile, and a
  // manifest that redirects to the gate installs a tile that opens the gate.
  if (pathname.endsWith("/manifest.webmanifest")) {
    return NextResponse.next();
  }

  const ok =
    (await verifyToken(req.cookies.get(COOKIE)?.value)) ||
    (await readDeviceToken(req.cookies.get(DEVICE_COOKIE)?.value)) !== null;
  if (!ok) {
    const url = req.nextUrl.clone();
    url.pathname = "/gate";
    url.search = "";
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  const res = NextResponse.next();
  // This surface shows a third party's customer data on some routes and
  // Juan's own pay data on others; neither has business being indexed.
  res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
