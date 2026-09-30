/**
 * Route. A day's stops, routed on the real road network, with business
 * hours a hard constraint. Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/map/page.tsx + MapScreen.tsx + RoutePanel.tsx).
 * See PORTING.md and this feature's own header comment in RouteClient.tsx
 * for what changed in the port.
 */
import { PageHead } from "../../../lib/core/ui";
import { RouteClient } from "./RouteClient";

// Static: served from the CDN, gated by proxy, data loads through API
// routes that each check access.
export const dynamic = "force-static";

export const metadata = {
  title: "Route · ClientOS",
  appleWebApp: { title: "Route" },
};

export default function RoutePage() {
  return (
    <>
      <PageHead title="Route" />
      <RouteClient />
    </>
  );
}
