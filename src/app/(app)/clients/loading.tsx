import { SkeletonBar } from "../../../lib/core/ui";

export default function Loading() {
  return (
    <div className="flex flex-col gap-3">
      <SkeletonBar className="mb-3 h-[34px] w-40" />
      <SkeletonBar className="h-9 w-full max-w-[640px]" />
      {Array.from({ length: 8 }).map((_, i) => (
        <SkeletonBar key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}
