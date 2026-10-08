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
import { COOKIE, DEVICE_COOKIE, readDeviceToken, readSessionUser } from "./lib/core/session";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // The gate itself and every API route stay reachable while signed out:
  // the gate obviously needs to be, and api/auth is what mints the session.
  /* The path every gate check judges a rep's screens against (devices.ts
     allowedHere). Set here, overwriting anything the client sent, because a
     route handler cannot see its own path any other way. */
  const forward = new Headers(req.headers);
  forward.set("x-nb-path", pathname);
  const pass = () => NextResponse.next({ request: { headers: forward } });

  /* Which rep this request is for, from the signed session, else the signed
     remembered-device cookie ("<device>~<rep>"; an old one with no rep is
     Juan's, as in user.ts deviceUser). Nothing is looked up. */
  const repOf = async (): Promise<string | null> => {
    const sessionRep = await readSessionUser(req.cookies.get(COOKIE)?.value);
    if (sessionRep) return sessionRep;
    const device = await readDeviceToken(req.cookies.get(DEVICE_COOKIE)?.value);
    return device === null ? null : device.includes("~") ? device.slice(device.indexOf("~") + 1) : "juan";
  };

  if (pathname === "/gate" || pathname.startsWith("/api/")) {
    /* A write the phone queued names the rep who made it (x-nb-as, see
       lib/core/writeq.ts and outbox.ts). Sent under the other rep's session
       it is refused, never filed: the phone keeps it and retries. */
    const as = req.headers.get("x-nb-as");
    const rep = as ? await repOf() : null;
    if (as && rep && as !== rep) {
      return NextResponse.json({ ok: false, error: "Signed in as another rep." }, { status: 421 });
    }
    return pass();
  }

  // Home Screen manifests: iOS fetches one while installing a tile, and a
  // manifest that redirects to the gate installs a tile that opens the gate.
  // The service worker script likewise: a redirect is not a script.
  if (pathname.endsWith("/manifest.webmanifest") || pathname === "/sw.js") {
    return NextResponse.next();
  }

  const rep = await repOf();
  if (!rep) {
    const url = req.nextUrl.clone();
    url.pathname = "/gate";
    url.search = "";
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  const res = pass();
  // This surface shows a third party's customer data on some routes and
  // Juan's own pay data on others; neither has business being indexed.
  res.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "no-referrer");
  // The service worker keeps a copy of a screen only under the rep it was
  // rendered for, and wipes the copies when another rep's answer arrives.
  res.headers.set("x-nb-rep", rep);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
