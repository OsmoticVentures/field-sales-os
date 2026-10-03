import { Suspense } from "react";
import { PageHead } from "../../../lib/core/ui";
import { VisitClient } from "./VisitClient";

// Static: served from the CDN, gated by proxy, data loads through API
// routes that each check access. The chosen client rides in the query and
// is read on the phone (VisitClient), so this page never renders per request.
export const dynamic = "force-static";

export const metadata = { title: "Visit · ClientOS" };

export default function VisitPage() {
  return (
    <div className="mx-auto w-full max-w-[600px]">
      <PageHead title="Visit" />
      <Suspense fallback={<div className="h-40 animate-pulse rounded-xl bg-[#ECEAE1] motion-reduce:animate-none" />}>
        <VisitClient />
      </Suspense>
    </div>
  );
}
