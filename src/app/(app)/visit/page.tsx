import Link from "next/link";
import { PageHead } from "../../../lib/core/ui";
import { TouchpointCapture } from "../../../lib/features/visit/ui";

export const dynamic = "force-dynamic";

export const metadata = { title: "Visit · Field Sales OS" };

export default function VisitPage() {
  return (
    <>
      <PageHead title="Visit" />
      <div className="flex flex-col gap-4">
        <TouchpointCapture />
        <div className="mx-auto w-full max-w-[600px] text-right">
          <Link href="/visit/review" className="text-[12.5px] text-[#8A928C] underline-offset-2 hover:underline">
            Review queue
          </Link>
        </div>
      </div>
    </>
  );
}
