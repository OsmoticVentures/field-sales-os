import { SkeletonBar } from "../../../lib/core/ui";

/** The Workflow screen's frame while its chunk loads: head, tabs, a picker
 *  row, then the designer's surface. */
export default function Loading() {
  return (
    <div className="flex w-full flex-col gap-4">
      <SkeletonBar className="h-9 w-40" />
      <SkeletonBar className="h-11 w-56" />
      <SkeletonBar className="h-11 w-full max-w-[520px]" />
      <SkeletonBar className="h-72 w-full" />
    </div>
  );
}
