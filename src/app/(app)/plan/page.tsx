/**
 * Plan week. The route planner running inside the app: a proposed drivable
 * week, day by day, one tap to put a day on the route. See PlanWeekClient
 * for the screen, src/lib/features/planner/ for the planner itself.
 */
import { PlanWeekClient } from "./PlanWeekClient";
import { PageHead } from "../../../lib/core/ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Plan week · Field Sales OS",
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
