import { PageHead } from "../../../lib/core/ui";
import { TouchpointCapture } from "../../../lib/features/visit/ui";

// Static: served from the CDN, gated by proxy, data loads through API
// routes that each check access.
export const dynamic = "force-static";

export const metadata = { title: "Visit · ClientOS" };

export default function VisitPage() {
  return (
    <div className="mx-auto w-full max-w-[600px]">
      <PageHead title="Visit" />
      <TouchpointCapture />
    </div>
  );
}
