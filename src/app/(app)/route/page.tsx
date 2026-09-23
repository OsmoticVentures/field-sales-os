/**
 * Route. A day's stops, routed on the real road network, with business
 * hours a hard constraint. Ported from the NutriBiotic OS
 * (portfolio/src/app/nutribiotic/map/page.tsx + MapScreen.tsx + RoutePanel.tsx).
 * See PORTING.md and this feature's own header comment in RouteClient.tsx
 * for what changed in the port.
 */
import { PageHead } from "../../../lib/core/ui";
import { RouteClient } from "./RouteClient";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Route · Field Sales OS",
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
