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
};

export default nextConfig;
