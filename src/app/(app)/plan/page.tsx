/**
 * Plan week. The route planner running inside the app: a proposed drivable
 * week, day by day, one tap to put a day on the route. See PlanWeekClient
 * for the screen, src/lib/features/planner/ for the planner itself.
 */
import { PlanWeekClient } from "./PlanWeekClient";
import { PageHead } from "../../../lib/core/ui";

// Static: served from the CDN, gated by proxy, data loads through API
// routes that each check access.
export const dynamic = "force-static";

export const metadata = {
  title: "Plan week · ClientOS",
  appleWebApp: { title: "Plan week" },
};

export default function PlanPage() {
  return (
    <>
      <PageHead title="Plan week" />
      <PlanWeekClient />
    </>
  );
}
