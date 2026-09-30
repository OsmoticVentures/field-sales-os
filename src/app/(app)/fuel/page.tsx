/**
 * Fuel. A tank gauge, a destination, then the cheapest stop on the way,
 * ranked by real posted price plus the true OSRM detour cost. Ported from
 * the standalone tool (portfolio/src/app/gas/page.tsx). See
 * lib/features/fuel for the routing and ranking math, FuelClient.tsx for the
 * form.
 */
import { FuelClient } from "./FuelClient";
import { PageHead } from "../../../lib/core/ui";

// Static: served from the CDN, gated by proxy, data loads through API
// routes that each check access.
export const dynamic = "force-static";

export const metadata = {
  title: "Fuel · ClientOS",
  appleWebApp: { title: "Fuel" },
};

export default function FuelPage() {
  return (
    <>
      <PageHead title="Fuel" sub="Cheapest fill on your route" />
      <FuelClient />
    </>
  );
}
