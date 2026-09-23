import { PageHead } from "../../../../lib/core/ui";
import { ReviewQueues } from "../../../../lib/features/visit/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Visit review · Field Sales OS" };

/**
 * The manual review backlog: touchpoints parked days ago with nothing
 * resolved at capture time. Per the feature inventory, this piece used to
 * live on the left-behind "clients" page (VisitQueues/UnmatchedTouchpoints/
 * EngagementQueue); it rides along here as a sub-view of Visit so a parked
 * note always has a screen to resolve on.
 */
export default function VisitReviewPage() {
  return (
    <>
      <PageHead title="Review" sub="Notes waiting on you" />
      <ReviewQueues />
    </>
  );
}
