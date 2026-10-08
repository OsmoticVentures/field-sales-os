import type { NextConfig } from "next";

// Served at osmoticventures.com/nb via the Next.js Multi-Zones pattern (see
// projects/nutribiotic-field-os-publishing/research/nb-serving-mechanism.md, H1).
// This app owns the /nb path itself; osmotic-ventures/site will add the
// matching rewrite in its own next.config.ts at m6 (not yet done).
const nextConfig: NextConfig = {
  basePath: "/nb",
  // Keep the client bundle honest: nothing here should ship a server secret.
  // Every route that reads process.env.* for a token lives in a route
  // handler, never a client component (see PORTING.md, added at m7).

  // The root answers at the edge, no function start, no page render.
  // basePath-relative: this is /nb -> /nb/visit.
  // The service worker (OFFLINE.md) lives at /nb/sw.js and controls /nb
  // itself as well as everything under it, so the app's own launch URL is
  // answered from the phone. Never cached by the browser: an update must
  // be seen on the next open.
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Service-Worker-Allowed", value: "/nb" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
  async redirects() {
    return [{ source: "/", destination: "/visit", permanent: false }];
  },
};

export default nextConfig;
