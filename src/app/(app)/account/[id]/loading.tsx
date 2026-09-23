import { SkeletonBar } from "../../../../lib/core/ui";

export default function Loading() {
  return (
    <>
      <div className="mb-6">
        <SkeletonBar className="h-[34px] w-[min(420px,70%)]" />
        <SkeletonBar className="mt-1.5 h-[21px] w-[min(340px,60%)]" />
      </div>
      <div className="mb-5 flex flex-wrap gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonBar key={i} className="h-11 w-32" />
        ))}
      </div>
      <div className="flex flex-col gap-4">
        <SkeletonBar className="h-[180px] w-full rounded-lg" />
        <SkeletonBar className="h-[140px] w-full rounded-lg" />
      </div>
    </>
  );
}
