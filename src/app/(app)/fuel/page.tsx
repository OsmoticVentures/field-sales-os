/**
 * Fuel. A tank gauge, a destination, then the cheapest stop on the way,
 * ranked by real posted price plus the true OSRM detour cost. Ported from
 * the standalone tool (portfolio/src/app/gas/page.tsx). See
 * lib/features/fuel for the routing and ranking math, FuelClient.tsx for the
 * form.
 */
import { FuelClient } from "./FuelClient";
import { PageHead } from "../../../lib/core/ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Fuel · Field Sales OS",
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
