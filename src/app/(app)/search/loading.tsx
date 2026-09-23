import { SkeletonBar } from "../../../lib/features/search/icons";

export default function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <SkeletonBar className="h-9 w-40" />
      <SkeletonBar className="h-72 w-full" />
    </div>
  );
}
