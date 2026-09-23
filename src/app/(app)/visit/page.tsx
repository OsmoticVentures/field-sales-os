import Link from "next/link";
import { PageHead } from "../../../lib/core/ui";
import { TouchpointCapture } from "../../../lib/features/visit/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Visit · Field Sales OS" };

export default function VisitPage() {
  return (
    <div className="mx-auto w-full max-w-[600px]">
      <PageHead title="Visit" />
      <div className="flex flex-col gap-4">
        <TouchpointCapture />
        <div className="text-right">
          <Link
            href="/visit/review"
            className="inline-flex min-h-11 items-center px-2 text-[13px] text-[#8A928C] underline-offset-2 hover:underline"
          >
            Review queue
          </Link>
        </div>
      </div>
    </div>
  );
}
